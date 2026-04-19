# ContractSigner

A private, no-login web app for signing contracts digitally between a developer and a client.

## How it works

1. **Developer** uploads a prefilled PDF contract
2. **Developer** signs it with a drawn signature (embedded + dated)
3. **Developer** sets a security code and generates a shareable link
4. **Developer** sends the link + code to the client (separately, e.g. via WhatsApp)
5. **Client** opens the link, enters the code to unlock the contract
6. **Client** reads through the signed contract, draws their signature
7. **Client** confirms submission — both parties can download the final signed PDF

## Setup & Running

### Requirements
- Node.js v16+

### Install
```bash
npm install
```

### Run locally
```bash
node server.js
```
Then open: http://localhost:3000

### Environment variables (optional)
```
PORT=3000         # Change the port
```

## Deployment (free)

### Railway
1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Done — Railway auto-detects Node.js

### Render
1. Push to GitHub
2. Go to https://render.com → New Web Service
3. Set build command: `npm install`
4. Set start command: `node server.js`

## Project structure

```
contract-signer/
├── server.js           # Express backend
├── public/
│   ├── dev/            # Developer dashboard
│   │   └── index.html
│   └── client/         # Client signing page
│       └── index.html
├── uploads/            # Uploaded + dev-signed PDFs (auto-created)
├── signed/             # Final double-signed PDFs (auto-created)
└── package.json
```

## Notes

- Contract data is stored **in memory** — it resets when the server restarts.
  For production, replace the `contracts` Map in server.js with a SQLite or
  PostgreSQL database.
- PDFs are stored on the local filesystem. For cloud deployment, swap to
  an object store like AWS S3 or Cloudflare R2.
- Security codes are hashed with bcrypt before storage.
- The dev interface (/dev) and client interface (/sign/:id) are completely
  separate — clients never see the developer dashboard.
