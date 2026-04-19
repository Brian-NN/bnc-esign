'use strict';
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// In-memory store (replace with SQLite/DB in production)
const contracts = new Map();

// Ensure upload dirs exist
['uploads', 'signed'].forEach(d => {
  if (!fs.existsSync(path.join(__dirname, d))) fs.mkdirSync(path.join(__dirname, d));
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, uuidv4() + '.pdf')
});
const upload = multer({ storage, fileFilter: (req, file, cb) => cb(null, file.mimetype === 'application/pdf') });

// Serve static files
app.use('/dev', express.static(path.join(__dirname, 'public/dev')));
app.use('/client', express.static(path.join(__dirname, 'public/client')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));

// Dev dashboard
app.get('/', (req, res) => res.redirect('/dev'));
app.get('/dev', (req, res) => res.sendFile(path.join(__dirname, 'public/dev/index.html')));
app.get('/sign/:contractId', (req, res) => res.sendFile(path.join(__dirname, 'public/client/index.html')));

// Upload PDF (dev only)
app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  const contractId = uuidv4();
  contracts.set(contractId, {
    id: contractId,
    originalPath: req.file.path,
    devSignedPath: null,
    finalPath: null,
    devSignature: null,
    clientSignature: null,
    devDate: null,
    clientDate: null,
    devEmail: req.body.devEmail || '',
    clientEmail: req.body.clientEmail || '',
    securityCodeHash: null,
    status: 'uploaded', // uploaded -> dev_signed -> client_signed
    createdAt: new Date().toISOString()
  });
  res.json({ contractId });
});

// Dev signs the contract
app.post('/api/contracts/:id/dev-sign', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'uploaded') return res.status(400).json({ error: 'Already signed' });

  const { signatureDataUrl, devEmail, clientEmail } = req.body;
  if (!signatureDataUrl) return res.status(400).json({ error: 'No signature provided' });

  try {
    const pdfBytes = fs.readFileSync(contract.originalPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];
    const { width, height } = lastPage.getSize();

    // Embed signature image
    const sigData = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
    const sigImage = await pdfDoc.embedPng(Buffer.from(sigData, 'base64'));
    const sigDims = sigImage.scale(0.4);

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    // Place dev signature in bottom-left area
    lastPage.drawImage(sigImage, {
      x: 60,
      y: 80,
      width: sigDims.width,
      height: sigDims.height,
    });

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    lastPage.drawText(`Developer: ${dateStr} ${timeStr}`, {
      x: 60, y: 68, size: 9, font, color: rgb(0.3, 0.3, 0.3)
    });
    lastPage.drawText('Digitally signed via ContractSigner', {
      x: 60, y: 58, size: 7, font, color: rgb(0.5, 0.5, 0.5)
    });

    const outPath = path.join(__dirname, 'uploads', `dev_signed_${contract.id}.pdf`);
    fs.writeFileSync(outPath, await pdfDoc.save());

    contract.devSignedPath = outPath;
    contract.devSignature = signatureDataUrl;
    contract.devDate = now.toISOString();
    contract.devEmail = devEmail || contract.devEmail;
    contract.clientEmail = clientEmail || contract.clientEmail;
    contract.status = 'dev_signed';

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to embed signature' });
  }
});

// Generate shareable link with security code
app.post('/api/contracts/:id/generate-link', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status !== 'dev_signed') return res.status(400).json({ error: 'Dev must sign first' });

  const { securityCode } = req.body;
  if (!securityCode || securityCode.length < 4) return res.status(400).json({ error: 'Code must be at least 4 characters' });

  contract.securityCodeHash = await bcrypt.hash(securityCode, 10);
  const link = `${req.protocol}://${req.get('host')}/sign/${contract.id}`;
  res.json({ link });
});

// Get contract info for dev dashboard
app.get('/api/contracts/:id', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  res.json({
    id: contract.id,
    status: contract.status,
    devDate: contract.devDate,
    clientDate: contract.clientDate,
    devEmail: contract.devEmail,
    clientEmail: contract.clientEmail,
    createdAt: contract.createdAt
  });
});

// List all contracts (dev)
app.get('/api/contracts', (req, res) => {
  const list = [...contracts.values()].map(c => ({
    id: c.id,
    status: c.status,
    devEmail: c.devEmail,
    clientEmail: c.clientEmail,
    devDate: c.devDate,
    clientDate: c.clientDate,
    createdAt: c.createdAt
  }));
  res.json(list.reverse());
});

// Verify security code (client)
app.post('/api/contracts/:id/verify', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Contract not found' });
  if (contract.status === 'uploaded') return res.status(403).json({ error: 'Contract not ready yet' });

  const { code } = req.body;
  const valid = await bcrypt.compare(code, contract.securityCodeHash);
  if (!valid) return res.status(403).json({ error: 'Incorrect code' });

  res.json({ success: true, status: contract.status });
});

// Serve PDF to client (after code verification, send as base64)
app.post('/api/contracts/:id/pdf', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Not found' });

  const { code } = req.body;
  const valid = await bcrypt.compare(code, contract.securityCodeHash);
  if (!valid) return res.status(403).json({ error: 'Unauthorized' });

  const pdfPath = contract.finalPath || contract.devSignedPath;
  const pdfBytes = fs.readFileSync(pdfPath);
  res.json({ pdf: pdfBytes.toString('base64'), status: contract.status });
});

// Client signs
app.post('/api/contracts/:id/client-sign', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  if (contract.status !== 'dev_signed') return res.status(400).json({ error: 'Already signed or not ready' });

  const { code, signatureDataUrl, clientName } = req.body;
  const valid = await bcrypt.compare(code, contract.securityCodeHash);
  if (!valid) return res.status(403).json({ error: 'Unauthorized' });
  if (!signatureDataUrl) return res.status(400).json({ error: 'No signature' });

  try {
    const pdfBytes = fs.readFileSync(contract.devSignedPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const pages = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];

    const sigData = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
    const sigImage = await pdfDoc.embedPng(Buffer.from(sigData, 'base64'));
    const sigDims = sigImage.scale(0.4);

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    // Place client signature in bottom-right area
    const { width } = lastPage.getSize();
    lastPage.drawImage(sigImage, {
      x: width / 2 + 20,
      y: 80,
      width: sigDims.width,
      height: sigDims.height,
    });

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    lastPage.drawText(`Client${clientName ? ' (' + clientName + ')' : ''}: ${dateStr} ${timeStr}`, {
      x: width / 2 + 20, y: 68, size: 9, font, color: rgb(0.3, 0.3, 0.3)
    });
    lastPage.drawText('Digitally signed via ContractSigner', {
      x: width / 2 + 20, y: 58, size: 7, font, color: rgb(0.5, 0.5, 0.5)
    });

    const finalPath = path.join(__dirname, 'signed', `final_${contract.id}.pdf`);
    fs.writeFileSync(finalPath, await pdfDoc.save());

    contract.finalPath = finalPath;
    contract.clientSignature = signatureDataUrl;
    contract.clientDate = now.toISOString();
    contract.status = 'client_signed';

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to sign' });
  }
});

// Download final signed PDF (both parties)
app.post('/api/contracts/:id/download', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract || !contract.finalPath) return res.status(404).json({ error: 'Not found or not fully signed' });

  const { code } = req.body;
  if (code) {
    const valid = await bcrypt.compare(code, contract.securityCodeHash);
    if (!valid) return res.status(403).json({ error: 'Unauthorized' });
  }

  const pdfBytes = fs.readFileSync(contract.finalPath);
  res.json({ pdf: pdfBytes.toString('base64') });
});

// Dev download (no code needed — dev owns the session)
app.get('/api/contracts/:id/download-dev', (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  const pdfPath = contract.finalPath || contract.devSignedPath || contract.originalPath;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="contract-${contract.id.slice(0,8)}.pdf"`);
  res.sendFile(pdfPath);
});

// Request amendment (client sends note back)
app.post('/api/contracts/:id/amendment', async (req, res) => {
  const contract = contracts.get(req.params.id);
  if (!contract) return res.status(404).json({ error: 'Not found' });
  const { code, note } = req.body;
  const valid = await bcrypt.compare(code, contract.securityCodeHash);
  if (!valid) return res.status(403).json({ error: 'Unauthorized' });
  contract.amendmentNote = note;
  contract.status = 'amendment_requested';
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ContractSigner running on http://localhost:${PORT}`));
