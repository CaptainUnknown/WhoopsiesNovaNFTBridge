import express from "express";
import { getRequiredEnvVar, setDefaultEnvVar } from "./envHelpers";
import {
  addAlchemyContextToRequest,
  AlchemyWebhookEvent, isValidSignatureForAlchemyRequest, AlchemyRequest,
} from "./webhooksUtil";
import { Alchemy, Network, WebhookType } from "alchemy-sdk";
import ngrok from '@ngrok/ngrok';
import { ethers } from "ethers";
import Erc721Abi from "./abis/erc721Abi.json";
import wrapperAbi from "./abis/wrapperAbi.json";

async function main(): Promise<void> {
  setDefaultEnvVar("PORT", "8080");
  setDefaultEnvVar("HOST", "127.0.0.1");
  setDefaultEnvVar("RPC_URL_NOVA", "");
  setDefaultEnvVar("RPC_URL_ETH", "");
  setDefaultEnvVar("PRIVATE_KEY", "");
  setDefaultEnvVar("NFT_BRIDGE_ADDRESS_L2", "");
  setDefaultEnvVar("NFT_BRIDGE_ADDRESS_RECEIVER", "");
  setDefaultEnvVar("ALCHEMY_AUTH", "")
  setDefaultEnvVar("NGROK_AUTH", "");
  setDefaultEnvVar("NGROK_DOMAIN", "");

  const port = +getRequiredEnvVar("PORT");
  const host = getRequiredEnvVar("HOST");
  const rpcUrl = getRequiredEnvVar("RPC_URL_NOVA");
  const rpcUrlEth = getRequiredEnvVar("RPC_URL_ETH");
  const walletPK = getRequiredEnvVar("PRIVATE_KEY");
  const nftBridgeAddress_L2 = getRequiredEnvVar("NFT_BRIDGE_ADDRESS_L2");
  const nftBridgeAddress_Receiver = getRequiredEnvVar("NFT_BRIDGE_ADDRESS_RECEIVER");
  const alchemyAuthToken = getRequiredEnvVar("ALCHEMY_AUTH");
  const ngrokAuthToken = getRequiredEnvVar("NGROK_AUTH");
  const ngrokDomain = getRequiredEnvVar("NGROK_DOMAIN");

  console.log(` Environment Configuration `);

  console.log(`\u203A Server Configuration`);
  console.log(`- Port: ${port}`);
  console.log(`- Host: ${host}`);

  console.log(`\u203A Blockchain Node Configuration`);
  console.log(`- RPC URL: ${rpcUrl}`);

  console.log(`\u203A Wallet Configuration`);
  console.log(`- Private Key: ${walletPK}`);

  console.log(`\u203A Contract Addresses`);
  console.log(`- Bridge Address: ${nftBridgeAddress_L2}`);
  console.log(`- Bridge Receiver: ${nftBridgeAddress_Receiver}`);

  console.log(`\u203A External Service Configuration`);
  console.log(`- Alchemy Authentication Token: ${alchemyAuthToken}`);
  console.log(`- Ngrok Authentication Token: ${ngrokAuthToken}`);
  console.log(`- Ngrok Domain: ${ngrokDomain}`);

  const novaProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const ethProvider = new ethers.providers.JsonRpcProvider(rpcUrlEth);
  const novaSigner = new ethers.Wallet(walletPK, novaProvider);
  const nftBridgeContract = new ethers.Contract(nftBridgeAddress_L2, wrapperAbi, novaSigner);
  const ethSigner = new ethers.Wallet(walletPK, ethProvider);

  const settings = {
    authToken: alchemyAuthToken,
    network: Network.ETH_MAINNET,
  };
  const alchemy = new Alchemy(settings);
  const receiverActivityWebhook = await alchemy.notify.createWebhook(
      ngrokDomain + "/nft-l1-to-l2",
      WebhookType.ADDRESS_ACTIVITY,
      {
        addresses: [nftBridgeAddress_Receiver],
        network: Network.ETH_MAINNET,
      }
  );

  const signingKeyAddress = parseWebhookResponse(receiverActivityWebhook, "signingKey");

  // === WEBHOOK SERVER ===
  const app = express();

  // Middleware needed to validate the alchemy signature
  app.use(express.json({ verify: addAlchemyContextToRequest }));

  // == NFT BRIDGE ==
  app.post("/nft-l1-to-l2", async (req, res) => {
    if (!isValidSignatureForAlchemyRequest(req as AlchemyRequest, signingKeyAddress)) {
      const errMessage = "Signature validation failed, unauthorized!";
      res.status(403).send(errMessage);
      return;
    }
    const webhookEvent = req.body as AlchemyWebhookEvent;
    if (webhookEvent.event.activity[0] === undefined) {
      res.status(400).send("Invalid Request!");
      return;
    }

    try {
      res.status(200).send("Processing the Response...");
      const activity = webhookEvent.event.activity[0];
      console.log('Received')
      if (activity.category === 'token' && activity.erc721TokenId !== undefined) {
        const contract = activity.rawContract.address;
        const from = activity.fromAddress;
        const to = activity.toAddress;
        const tokenId = Number(activity.erc721TokenId);

        console.log("contract", contract);
        console.log("from", from);
        console.log("to", to);
        console.log("tokenId", tokenId);

        const requestedCollection = new ethers.Contract(contract, Erc721Abi, ethSigner);
        const tokenUri = await requestedCollection.tokenURI(ethers.BigNumber.from(tokenId));
        // const tx = await nftBridgeContract.wrapNFT(contract, ethers.utils.BigNumberFrom(tokenId.toString()), tokenUri);
        // await tx.wait();
        console.log('Bridged Successfully!');
      }
    } catch (err) {
      console.log("Bridge Failed: ", JSON.stringify(err, null, 2));
    }
  });

  // == LISTENER ==
  app.listen(port, host, async () => {
    console.log(`NFT Bridge listening at ${host}:${port}`);
    const ngrokUrl = await ngrok.connect({
      addr: port,
      authtoken: ngrokAuthToken,
      domain: 'sensibly-present-dragon.ngrok-free.app'
    });
    console.log(`Webhook exposed at: ${ngrokUrl.url()}`);
  });
}
main();

// === UTILITIES ===
function parseWebhookResponse(response:string, key:string) {
  const params = new URLSearchParams(response);
  return params.get(key);
}