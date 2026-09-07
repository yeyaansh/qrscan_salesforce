const nodemailer = require("nodemailer");

function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

async function sendDiscrepancyAlert({ to, storeName, storeNumber, rackLabel, scannedCode, expectedCode, notes, agentName, taskId }) {
  const transport = getTransport();
  const subject = `Rack discrepancy — Store ${storeNumber} (${rackLabel})`;
  const text = [
    `${agentName} reported an unresolved rack discrepancy during a store audit.`,
    ``,
    `Store: ${storeName} (#${storeNumber})`,
    `Rack: ${rackLabel}`,
    `Expected QR code: ${expectedCode}`,
    `Scanned QR code: ${scannedCode}`,
    `Agent notes: ${notes || "(none provided)"}`,
    taskId ? `A Salesforce Task (${taskId}) has been created for follow-up.` : "",
  ].join("\n");

  if (!transport) {
    console.warn("⚠️  SMTP not configured — skipping email, logging instead:\n", subject, "\n", text);
    return { sent: false, reason: "SMTP not configured" };
  }

  await transport.sendMail({
    from: process.env.SMTP_FROM || "no-reply@rackaudit.app",
    to,
    subject,
    text,
  });
  return { sent: true };
}

module.exports = { sendDiscrepancyAlert };
