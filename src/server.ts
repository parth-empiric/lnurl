import express, { Request, Response, Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';

// for swap
import { randomBytes } from 'crypto';
import { ECPairFactory } from 'ecpair';
import { Transaction, address, crypto, networks } from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';
// for claim
import {
  Musig,
  OutputType,
  SwapTreeSerializer,
  detectSwap,
  targetFee,
} from 'boltz-core';
import {
  TaprootUtils,
  constructClaimTransaction,
} from 'boltz-core';
import { init } from 'boltz-core/dist/lib/liquid/init.js';
import { default as zkpInit, Secp256k1ZKP } from '@vulpemventures/secp256k1-zkp';

import {
  User,
  Swap,
  LNURLPayResponse,
  BoltzResponse,
  PaymentResponse
} from './types.js';


dotenv.config();
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  throw new Error('Missing required environment variables');
}

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

let zkp: Secp256k1ZKP;
(async () => {
  zkp = await zkpInit.default();
  init(zkp);
})();

// LNURL-pay endpoint
router.get('/lnurlp/:username', async (req: Request, res: Response): Promise<void> => {

  const userName = req.params.username;

  const { data } = await supabase
    .from('users')
    .select('uuid')
    .eq('user_name', userName)
    .maybeSingle();

  if (data == null) {
    res.status(200).json({
      status: 'ERROR',
      reason: 'Unable to find valid user wallet.',
    });
    return;
  }

  const responseData: LNURLPayResponse = {
    callback: `${req.protocol}://${req.get('host')}/payreq/${data.uuid}`,
    maxSendable: 25000000000,
    minSendable: 1000000,
    metadata: JSON.stringify([
      ['text/plain', `Pay to manna wallet user: ${userName}`],
      ['text/identifier', `${userName}@mannabitcoin.com`],
    ]),
    commentAllowed: 255,
    tag: 'payRequest',
  };

  res.json(responseData);
});

// Callback endpoint for generating Bolt11 invoice
router.get('/payreq/:uuid', async (req: Request, res: Response): Promise<void> => {
  const uuid = req.params.uuid;
  const amount = req.query.amount as string;
  const note = (req.query.note || req.query.label) as string | undefined;
  const amountValue = parseInt(amount || '', 10);

  if (!amount || isNaN(amountValue) || amountValue < 1000000 || amountValue > 25000000000) {
    res.status(404).json({
      status: 'ERROR',
      reason: amount
        ? 'Amount is not within valid millisatoshi limits: 1000000 - 25000000000'
        : 'amount not supplied',
    });
    return;
  }

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('uuid', uuid)
    .maybeSingle();

  if (data == null) {
    res.status(404).json({
      status: 'ERROR',
      reason: 'LNURL Pay Transaction does not exist.',
    });
    return;
  }

  const user = data as User;
  const liquidAddress = user.liquid_addresses.length > 0
    ? user.liquid_addresses[0]
    : user.used_addresses[0];


  const preimage = randomBytes(32);
  const preimageHash = crypto.sha256(preimage).toString('hex');

  const keys = ECPairFactory(ecc).makeRandom();
  const privKeyHex = Buffer.from(keys.privateKey).toString('hex');
  const pubKeyHex = Buffer.from(keys.publicKey).toString('hex');

  const liquidAddressHash = crypto.sha256(Buffer.from(liquidAddress, 'utf-8'));
  const addressSignature = Buffer.from(keys.signSchnorr(liquidAddressHash)).toString('hex');

  try {
    const boltzResponse = await axios.post<BoltzResponse>(`${process.env.BOLTZ_API_URL}/swap/reverse`, {
      invoiceAmount: Math.floor(amountValue / 1000),
      to: 'L-BTC',
      from: 'BTC',
      // claimCovenant: false,
      claimPublicKey: pubKeyHex,
      preimageHash: preimageHash,
      claimAddress: liquidAddress,
      address: liquidAddress,
      description: note,
      referralId: 'Manna',
      addressSignature: addressSignature,
      webhook: {
        url: `https://${req.get('host')}/webhook/swap`,
        hashSwapId: false,
        status: ['transaction.mempool']
      }
    });

    const boltzData = boltzResponse.data;

    // Update user's addresses
    const index = user.liquid_addresses.indexOf(liquidAddress);
    if (index !== -1) {
      user.liquid_addresses.splice(index, 1);
    }
    user.used_addresses.push(liquidAddress);

    await supabase
      .from('users')
      .update({
        liquid_addresses: user.liquid_addresses,
        used_addresses: Array.from(new Set(user.used_addresses)),
      })
      .eq('uuid', uuid);

    // Store swap details
    const swap: Swap = {
      swap_id: boltzData.id,
      wallet_id: user.uuid,
      amount: amount,
      note: note,
      preImage: preimage.toString('hex'),
      preImageHash: preimageHash,
      privateKey: privKeyHex,
      pubKey: pubKeyHex,
      claimAddress: liquidAddress,
      invoice: boltzData.invoice,
      swapTree: JSON.stringify(boltzData.swapTree),
      lockupAddress: boltzData.lockupAddress,
      refundPubKey: boltzData.refundPublicKey,
      refundAddress: boltzData.refundAddress,
      timeoutBlockHeight: boltzData.timeoutBlockHeight,
      onChainAmount: boltzData.onchainAmount,
      blindingKey: boltzData.blindingKey,
    };

    await supabase.from('swaps').insert(swap);

    const response: PaymentResponse = {
      pr: boltzData.invoice,
      route: []
    };

    res.json(response);
    return;
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Failed to generate invoice',
    });
  }
});

// Webhook endpoint for Boltz swap updates
router.post('/webhook/swap', async (req: Request, res: Response): Promise<void> => {
  if(req.body.event !== 'swap.update') {
    res.json({ message: 'No event found!' });
    return;
  }

  if(!req.body.data || !req.body.data.id || !req.body.data.status) {
    res.json({ message: 'No data found!' });
    return;
  }

  const { data } = req.body;
  const { id: swapId, status } = data;

  if (status !== 'transaction.mempool') {
    res.json({ message: 'Status not handled' });
    return;
  }

  try {
    const transactionResponse = await axios.get(`${process.env.BOLTZ_API_URL}/swap/reverse/${swapId}/transaction`, {
      headers: {
        'accept': 'application/json'
      }
    });
    const transaction = transactionResponse.data;

    if(!transaction) {
      res.json({ message: 'No lockup transaction found!' });
      return;
    }

    // Get swap details from database
    const { data: swapData } = await supabase
      .from('swaps')
      .select('*')
      .eq('swap_id', swapId)
      .maybeSingle();

    if (!swapData) {
      res.status(404).json({ error: 'Swap not found' });
      return;
    }

    const keys: ECPairFactory = ECPairFactory(ecc).fromPrivateKey(Buffer.from(swapData.privateKey, 'hex'));
    const boltzPublicKey = Buffer.from(swapData.refundPubKey, 'hex');
    console.log(keys.publicKey.toString('hex'));
    console.log(keys.privateKey.toString('hex'));

    // Create a musig signing session
    const musig = new Musig(zkp, keys, randomBytes(32), [
      boltzPublicKey,
      Buffer.from(swapData.pubKey, 'hex'),
    ]);

    // Tweak the key with the swap tree
    const tweakedKey = TaprootUtils.tweakMusig(
      musig,
      SwapTreeSerializer.deserializeSwapTree(swapData.swapTree).tree,
    );

    // Parse and verify the lockup transaction
    const lockupTx = Transaction.fromHex(transaction.hex);
    const swapOutput = detectSwap(tweakedKey, lockupTx);

    console.log(tweakedKey);
    console.log(lockupTx.outs.map(o => o.script));
    console.log(lockupTx);
    console.log(swapOutput);
    
    if (!swapOutput) {
      res.status(400).json({ error: 'No swap output found in lockup transaction' });
      return;
    }

    // Create claim transaction
    const claimTx = targetFee(0.1, (fee) =>
      constructClaimTransaction(
        [{
          ...swapOutput,
          keys,
          preimage: Buffer.from(swapData.preImage, 'hex'),
          cooperative: true,
          type: OutputType.Taproot,
          txHash: lockupTx.getHash(),
          value: Number(swapOutput.value),
          
          // blindingPrivateKey: Buffer.from(swapData.blindingKey, 'hex'),
        }],
        address.toOutputScript(swapData.claimAddress, networks.liquid),
        fee,
        false
      ),true,
    );

    console.log(claimTx);

    // Get Boltz's partial signature
    const boltzSig = (
      await axios.post(
        `${process.env.BOLTZ_API_URL}/swap/reverse/${swapId}/claim`,
        {
          index: 0,
          transaction: claimTx.toHex(),
          preimage: swapData.preImage,
          pubNonce: Buffer.from(musig.getPublicNonce()).toString('hex'),
        },
      )
    ).data;

    console.log(boltzSig);

    // Aggregate nonces
    musig.aggregateNonces([
      [boltzPublicKey, Buffer.from(boltzSig.pubNonce, 'hex')],
    ]);

    console.log(musig);

    // Initialize signing session
    musig.initializeSession(
      claimTx.hashForWitnessV1(
        0,
        [swapOutput.script],
        [Number(swapOutput.value)],
        Transaction.SIGHASH_DEFAULT,
        networks.liquid.genesisBlockHash,
      ),
    );

    console.log(musig);

    // Add Boltz's partial signature
    musig.addPartial(
      boltzPublicKey,
      Buffer.from(boltzSig.partialSignature, 'hex'),
    );

    console.log(musig);

    // Create our partial signature
    musig.signPartial();

    console.log(musig);

    // Add witness with aggregated signature
    claimTx.ins[0].witness = [musig.aggregatePartials()];

    console.log(claimTx);

    // Broadcast the claim transaction
    await axios.post(`${process.env.BOLTZ_API_URL}/chain/L-BTC/transaction`, {
      hex: claimTx.toHex(),
    });

    console.log('Claim transaction broadcast successfully');

    res.json({ message: 'Claim transaction broadcast successfully' });
  } catch (error) {
    console.error('Error processing swap webhook:', error);
    res.status(500).json({ error: 'Failed to process swap' });
  }
});

const app = express();
app.use(express.json());
app.use(router);const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

