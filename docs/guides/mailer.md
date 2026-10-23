# Mailer

Every EFC app has a `SendEmail` background task. In the base app it's a stub that logs the message. The **email client** feature (`email-client`, alias `mailer`) replaces it with a real `nodemailer` transport wired to environment variables, so you never hand-write SMTP boilerplate.

---

## Enabling it

Pick **Email client** under *Integrations* when `create-efc-app` asks which features to add, or add it to an existing app:

```bash
efc add email-client     # replaces the SendEmail stub, adds nodemailer, asks for your SMTP settings
```

Both ask the same questions and write the answers to `.env`. (Without a terminal, or with `--no-prompt`, `efc add` writes placeholders instead.)

```
? Email provider:
  ❯ Gmail             smtp.gmail.com, preconfigured
    Other (custom SMTP)  you'll provide host + port
```

- **Gmail** — the wizard hard-codes `SMTP_HOST=smtp.gmail.com` and `SMTP_PORT=465` for you. No host or port question is asked.
- **Other (custom SMTP)** — you're prompted for `SMTP host:` (e.g. `smtp.mailtrap.io`, `smtp.sendgrid.net`) and `SMTP port:` (default `587`).

Both paths then ask for the sending address and password:

```
? Gmail address:            you@example.com
? Gmail app password (16 characters): ****************
```

---

## Gmail requires an App Password, not your login password

Google no longer accepts a regular account password for SMTP. If you pick **Gmail**, the wizard shows a note before the password prompt:

> Google no longer accepts your regular account password for SMTP.
> Generate a 16-character App Password: **Google Account → Security → 2-Step Verification → App passwords**.
> Enter it below without spaces (not your Gmail login password).

The password prompt then **validates the input is exactly 16 characters** (after stripping whitespace) — if you paste your normal password, or the app password with spaces left in from Google's display format (`abcd efgh ijkl mnop`), the wizard rejects it and asks again. Spaces are stripped automatically before the value is written to `.env`.

2-Step Verification must be enabled on the Google account before an App Password can be generated.

For a custom SMTP provider, use whatever credential that provider issues (API key, SMTP password, etc.) — there's no length validation since providers vary.

---

## What gets generated

### `.env`

```bash
APP_URL=http://localhost:3000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@example.com
SMTP_PASS=abcdefghijklmnop # Gmail App Password (16 chars) — NOT your regular Gmail password. Generate at: Google Account > Security > 2-Step Verification > App passwords
SMTP_FROM=you@example.com
```

`APP_URL` is the base URL used to build the links inside verification/reset emails (see below) — update it to your real domain before deploying. For a custom provider, `SMTP_HOST`/`SMTP_PORT` reflect what you entered and the comment on `SMTP_PASS` is omitted.

### `.env.example`

```bash
APP_URL=http://localhost:3000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your@email.com
SMTP_PASS=your_16_char_app_password
SMTP_FROM=noreply@yourapp.com
```

(`your_smtp_password` instead of `your_16_char_app_password` for a custom provider.)

### `src/tasks/SendEmail.ts`

```ts
import { defineTask } from 'express-file-cluster/tasks';
import nodemailer from 'nodemailer';

interface SendEmailPayload {
  to: string;
  subject: string;
  body: string;
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export default defineTask<SendEmailPayload>(async (payload) => {
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: payload.to,
    subject: payload.subject,
    html: payload.body,
  });
});
```

If you enable **Background tasks** but not **Mailer**, this same file is created as a `console.log` stub instead — swap in the transporter above later if you add email support.

`nodemailer` (and `@types/nodemailer` for TypeScript projects) is added to `package.json` automatically.

---

## Sending an email from a route

Trigger the task with `enqueue()` — don't call the transporter directly from a request handler, since SMTP round-trips shouldn't block a response:

```ts
// src/api/users/index.ts
import { enqueue } from 'express-file-cluster/tasks';
import { User } from '../../model/User.js';

export const POST = async (req, res) => {
  const user = await User.create(req.body);

  await enqueue('SendEmail', {
    to: user.email,
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  });

  res.status(202).json({ id: user.id, queued: true });
};
```

See [Background Tasks](../core-concepts/background-tasks.md) for retry/backoff behavior and [Environment Variables](./environment-variables.md) for the full `SMTP_*` reference.

---

## Auth routes wired to the mailer

These generated routes always `enqueue('SendEmail', ...)`:

| Route | Sends |
|---|---|
| `POST /auth/register` | Verification email with a link to `${APP_URL}/auth/verify-email?token=...` |
| `POST /auth/verify-email` (resend) | Same verification email, with a freshly generated token |
| `POST /auth/forgot-password` | Reset email with a link to `${APP_URL}/auth/reset-password?token=...` |

Without the mailer, the base `SendEmail` stub just logs each message (recipient and subject), so registration and password reset work in development without SMTP. Run `efc add email-client` when you want real email.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Invalid login: 535-5.7.8 Username and Password not accepted` | You used your regular Gmail password instead of a 16-character App Password, or 2-Step Verification isn't enabled on the account. |
| `SMTP connection refused` (visible in task error logs) | Wrong `SMTP_HOST`/`SMTP_PORT`, or a firewall blocking outbound SMTP. |
| App Password option missing in Google Account settings | 2-Step Verification must be turned on first — Google hides App Passwords otherwise. |
