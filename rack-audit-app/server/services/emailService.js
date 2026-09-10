// NOT currently called from anywhere in the app. Per current architecture,
// Salesforce owns discrepancy notifications (Case creation, emails, alerts)
// via its own Flow/automation triggered off Status__c — this app only
// updates that field (see routes/racks.js). Kept here in case app-triggered
// email is ever wanted again; wire sendDiscrepancyAlert() back into a route
// to reactivate it.
import nodemailer from "nodemailer";

function getTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

export async function sendDiscrepancyAlert({ to, storeName, storeNumber, rackLabel, notes, agentName }) {
  const transport = getTransport();
  const subject = `Rack discrepancy — Store ${storeNumber} (${rackLabel})`;
  const text = [
    `${agentName} reported an unresolved rack discrepancy during a store audit.`,
    ``,
    `Store: ${storeName} (#${storeNumber})`,
    `Rack: ${rackLabel}`,
    `Agent notes: ${notes || "(none provided)"}`,
  ].join("\n");

  if (!transport) {
    console.warn("⚠️  SMTP not configured — skipping email, logging instead:\n", subject, "\n", text);
    return { sent: false, reason: "SMTP not configured" };
  }

  await transport.sendMail({ from: process.env.SMTP_FROM || "no-reply@rackaudit.app", to, subject, text });
  return { sent: true };
}
