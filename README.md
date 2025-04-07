# LNURL-pay Server with Boltz Integration

This Node.js server implements LNURL-pay functionality with Boltz swap integration. It provides endpoints for LNURL-pay and handles the creation of Bolt11 invoices with Liquid swaps.

## Features

- LNURL-pay endpoint
- Bolt11 invoice generation
- Integration with Boltz for BTC to L-BTC swaps
- Supabase database integration for user and swap management

## Prerequisites

- Node.js 16+
- npm
- Supabase account with proper database setup
- Boltz API access

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with the following variables:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   BOLTZ_API_URL=https://api.boltz.exchange/v2
   PORT=3000 # Optional, defaults to 3000
   ```

## Running the Server

```bash
npm start
```

## API Endpoints

### 1. LNURL-pay Endpoint
```
GET /lnurlp/:username
```
Returns LNURL-pay metadata for the specified username.

### 2. Payment Request Endpoint
```
GET /payreq/:uuid
```
Generates a Bolt11 invoice and initiates a Boltz swap.

Query parameters:
- `amount`: Amount in millisatoshis
- `note` or `label`: Optional payment description

## Database Schema

The server expects the following tables in Supabase:

### Users Table
- uuid (primary key)
- user_name
- liquid_addresses (array)
- used_addresses (array)

### Swaps Table
- swap_id (primary key)
- wallet_id (foreign key to users.uuid)
- amount
- note
- preImage
- preImageHash
- privateKey
- pubKey
- claimAddress
- invoice
- swapTree
- lockupAddress
- refundPubKey
- refundAddress
- timeoutBlockHeight
- onChainAmount
- blindingKey 