import express from 'express';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

import { randomBytes } from 'crypto';
import { ECPairFactory } from 'ecpair';
import { Transaction, address, crypto, networks } from 'liquidjs-lib';
import * as ecc from 'tiny-secp256k1';
import {
  Musig,
  OutputType,
  SwapTreeSerializer,
  detectSwap,
  targetFee,
} from 'boltz-core';
// import {
//   TaprootUtils,
//   constructClaimTransaction,
//   init,
// } from 'boltz-core/dist/lib/liquid';

dotenv.config();

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// LNURL-pay endpoint
app.get('/lnurlp/:username', async (req, res) => {
  const userName = req.params.username;

  const { data } = await supabase
    .from('users')
    .select('uuid')
    .eq('user_name', userName)
    .maybeSingle();

  if (data == null) {
    return res.status(200).json({
      status: 'ERROR',
      reason: 'Unable to find valid user wallet.',
    });
  }

  const responseData = {
    callback: `${req.protocol}://${req.get('host')}/payreq/${data.uuid}`,
    maxSendable: 100000000000,
    minSendable: 1000,
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
app.get('/payreq/:uuid', async (req, res) => {
  const uuid = req.params.uuid;
  const amount = req.query.amount;
  const note = req.query.note || req.query.label;
  const amountValue = parseInt(amount || '', 10);

  if (!amount || isNaN(amountValue) || amountValue < 1000 || amountValue > 100000000000) {
    return res.status(404).json({
      status: 'ERROR',
      reason: amount
        ? 'Amount is not within valid millisatoshi limits: 1000 - 100000000000'
        : 'amount not supplied',
    });
  }

  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('uuid', uuid)
    .maybeSingle();

  if (data == null) {
    return res.status(404).json({
      status: 'ERROR',
      reason: 'User does not exist.',
    });
  }

  const liquidAddress = data.liquid_addresses.length > 0
    ? data.liquid_addresses[0]
    : data.used_addresses[Math.floor(Math.random() * data.used_addresses.length)];

  const preimage = randomBytes(32);
  const keys = ECPairFactory(ecc).makeRandom();
  const privKeyHex = Buffer.from(keys.privateKey).toString('hex');
  const pubKeyHex = Buffer.from(keys.publicKey).toString('hex');
  console.log(privKeyHex, pubKeyHex);
  // const liquidAddressHash = createHash('sha256').update(liquidAddress.toString());

  // const ec = new EC('secp256k1');
  // const keyPair = ec.genKeyPair();
  // const privKeyHex = keyPair.getPrivate('hex');
  // const pubKeyHex = keyPair.getPublic(true, 'hex');
  // const signatures = keyPair.sign(liquidAddressHash, pubKeyHex);
  // const derSignatureHex = signatures.toDER('hex');

  // const preimageHash = createHash('sha256').update(preimage).digest('hex');

  try {
  //   const boltzResponse = await axios.post(`${process.env.BOLTZ_API_URL}/swap/reverse`, {
  //     invoiceAmount: amountValue,
  //     to: 'L-BTC',
  //     from: 'BTC',
  //     claimCovenant: true,
  //     claimPublicKey: pubKeyHex,
  //     preimageHash: preimageHash,
  //     Signature: derSignatureHex,
  //     claimAddress: liquidAddress.toString(),
  //     address: liquidAddress.toString(),
  //     description: note?.toString(),
  //     referralId: 'Manna',
  //   });

  //   const res = boltzResponse.data;

  //   // Update user's addresses
  //   const index = data.liquid_addresses.indexOf(liquidAddress);
  //   if (index !== -1) {
  //     data.liquid_addresses.splice(index, 1);
  //   }
  //   data.used_addresses.push(liquidAddress);
    
  //   await supabase
  //     .from('users')
  //     .update({
  //       liquid_addresses: data.liquid_addresses,
  //       used_addresses: data.used_addresses,
  //     })
  //     .eq('uuid', uuid);

  //   // Store swap details
  //   await supabase
  //     .from('swaps')
  //     .insert({
  //       swap_id: res.id,
  //       wallet_id: data.uuid,
  //       amount: amount,
  //       note: note?.toString(),
  //       preImage: preimage.toString('hex'),
  //       preImageHash: preimageHash,
  //       privateKey: privKeyHex,
  //       pubKey: pubKeyHex,
  //       claimAddress: liquidAddress,
  //       invoice: res.invoice,
  //       swapTree: JSON.stringify(res.swapTree),
  //       lockupAddress: res.lockupAddress,
  //       refundPubKey: res.refundPublicKey,
  //       refundAddress: res.refundAddress,
  //       timeoutBlockHeight: res.timeoutBlockHeight,
  //       onChainAmount: res.onchainAmount,
  //       blindingKey: res.blindingKey,
  //     });

    res.json({ pr: res.invoice, route: [] });
  } catch (error) {
    console.error('Error creating invoice:', error);
    res.status(500).json({
      status: 'ERROR',
      reason: 'Failed to generate invoice',
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 