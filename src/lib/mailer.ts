// src/lib/mailer.ts
import nodemailer from "nodemailer";

type MailOpts = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
};

function makeTransport() {
  // Permite URL única (ex.: smtp://user:pass@smtp.host:587)
  const url = process.env.SMTP_URL;
  if (url) return nodemailer.createTransport(url);

  // Dev sem SMTP => não cria transport (vamos fazer fallback para console.log)
  const host = process.env.SMTP_HOST;
  if (!host || process.env.NODE_ENV === "development") return null;

  const port = Number(process.env.SMTP_PORT || 587);
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  const authUser = process.env.SMTP_USER;
  const auth = authUser
    ? { user: authUser, pass: process.env.SMTP_PASS || "" }
    : undefined;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth,
    // Timeouts e TLS mais previsíveis em produção
    connectionTimeout: Number(process.env.SMTP_CONN_TIMEOUT || 10_000),
    greetingTimeout: Number(process.env.SMTP_GREET_TIMEOUT || 10_000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 20_000),
    tls: {
      // permitir desativar verificação de certificado em ambientes específicos
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "0",
    },
  });
}

// overloads: 4 argumentos OU 1 objeto
export async function sendMail(
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<void>;
export async function sendMail(opts: MailOpts): Promise<void>;
export async function sendMail(a: string | MailOpts, b?: string, c?: string, d?: string) {
  const opts: MailOpts =
    typeof a === "string" ? { to: a, subject: b || "", text: c || "", html: d } : a;

  const from =
    opts.from || process.env.MAIL_FROM || "MindZapp <mindzapp@localhost>";

  const t = makeTransport();

  // Fallback de desenvolvimento: não tenta enviar, apenas loga
  if (!t) {
    console.log("[DEV-MAIL]", {
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return;
  }

  try {
    const info = await t.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || `<pre>${opts.text}</pre>`,
    });

    if (process.env.MAIL_LOG !== "0") {
      console.log(`[MAIL] sent id=${info.messageId} to=${opts.to} subject="${opts.subject}"`);
    }
  } catch (err: any) {
    // Em produção podes forçar erro com MAIL_STRICT=1
    const strict = process.env.MAIL_STRICT === "1" || process.env.NODE_ENV === "production";
    if (strict) throw err;
    console.warn("[MAIL] send failed (non-strict):", err?.message || err);
  }
}
