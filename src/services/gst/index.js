// GST provider adapter — abstracts E-Invoice (IRN) + E-Way Bill generation behind
// a stable interface so business logic never changes when the provider changes.
//
// Drivers:
//   - mock        : deterministic local generator (no creds) — for dev/demo
//   - nic-sandbox : (stub) official NIC IRP/E-Way Bill sandbox
//   - gsp         : (stub) a GST Suvidha Provider (ClearTax / Masters India / IRIS)
//
// Select via env GST_PROVIDER (default: mock). The real drivers throw "not
// configured" until credentials + endpoints are wired at go-live.

import { createHash } from 'node:crypto';

const PROVIDER = process.env.GST_PROVIDER || 'mock';

function nowIso() {
  return new Date().toISOString();
}

// ── Mock driver ──────────────────────────────────────────────
const mockDriver = {
  name: 'mock',
  async generateIRN({ invoice }) {
    // IRN is a 64-char hex hash of seller GSTIN + doc no + FY (per IRP spec shape).
    const irn = createHash('sha256')
      .update(`${invoice.invoiceNo}|${invoice.totalAmount}|${invoice.invoiceDate}`)
      .digest('hex');
    const ackNo = String(Math.abs(hashInt(invoice.invoiceNo))).padStart(15, '1').slice(0, 15);
    const signedQr = Buffer.from(
      JSON.stringify({ irn, no: invoice.invoiceNo, amt: invoice.totalAmount }),
    ).toString('base64');
    return {
      irn,
      ackNo,
      ackDate: nowIso(),
      signedQr,
      signedInvoice: signedQr,
      provider: 'mock',
    };
  },
  async generateEWB({ invoice, distanceKm = 100 }) {
    const ewbNo = String(Math.abs(hashInt('EWB' + invoice.invoiceNo)))
      .padStart(12, '2')
      .slice(0, 12);
    // EWB validity: 1 day per 200 km (min 1 day).
    const days = Math.max(1, Math.ceil((distanceKm || 100) / 200));
    const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    return { ewbNo, ewbDate: nowIso(), validUntil, provider: 'mock' };
  },
  async cancelIRN() {
    return { cancelled: true, provider: 'mock' };
  },
  async cancelEWB() {
    return { cancelled: true, provider: 'mock' };
  },
};

function hashInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ── Stub drivers (wired at go-live with creds/endpoints) ─────
function stub(name) {
  const notReady = async () => {
    const err = new Error(
      `GST provider "${name}" is not configured. Set credentials/endpoints or use GST_PROVIDER=mock.`,
    );
    err.statusCode = 503;
    throw err;
  };
  return { name, generateIRN: notReady, generateEWB: notReady, cancelIRN: notReady, cancelEWB: notReady };
}

const drivers = {
  mock: mockDriver,
  'nic-sandbox': stub('nic-sandbox'),
  gsp: stub('gsp'),
};

export const gstProvider = drivers[PROVIDER] ?? mockDriver;
export const gstProviderName = gstProvider.name;
