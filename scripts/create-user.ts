#!/usr/bin/env tsx
import "dotenv/config";
import bcrypt from "bcryptjs";

import config from "../src/config";
import {
  createUser,
  addDeviceSecret,
  findUserByUsername,
  loadUser,
  saveUser,
  setEmail,
} from "../src/lib/store";
import { insertAccount, findByEmail } from "../src/lib/accountStore";

interface CliOptions {
  username: string;
  email?: string;
  password?: string;
  skipAccount?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { username: "" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--email":
        opts.email = argv[++i];
        break;
      case "--password":
        opts.password = argv[++i];
        break;
      case "--skip-account":
        opts.skipAccount = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (!opts.username) {
          opts.username = arg;
        } else {
          console.error(`Unexpected argument: ${arg}`);
          printHelp();
          process.exit(1);
        }
    }
  }

  if (!opts.username) {
    console.error("Username is required.");
    printHelp();
    process.exit(1);
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: npm run create-user -- <username> [--email you@example.com --password secret] [--skip-account]

Creates a new MindZapp user JSON file. By default it also creates a verified email/password account entry
so that the user can login via /accounts/login. Pass --skip-account to only generate the user.json file.
`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const username = opts.username.trim();
  if (username.length < 3) {
    console.error("Username must be at least 3 characters long.");
    process.exit(1);
  }

  if (await findUserByUsername(username)) {
    console.error(`Username '${username}' already exists.`);
    process.exit(1);
  }

  if (!opts.skipAccount && opts.email) {
    const emailLower = opts.email.trim().toLowerCase();
    if (await findByEmail(emailLower)) {
      console.error(`Email '${opts.email}' already exists.`);
      process.exit(1);
    }
  }

  const user = await createUser(username);
  const deviceSecret = await addDeviceSecret(user.id);

  if (!opts.skipAccount && opts.email) {
    if (!opts.password || opts.password.length < 6) {
      console.error("Password must have at least 6 characters when creating an email account.");
      process.exit(1);
    }

    const email = opts.email.trim();
    const emailLower = email.toLowerCase();

    const hash = await bcrypt.hash(opts.password, config.security.bcryptCost);
    const now = new Date().toISOString();

    await insertAccount({
      userId: user.id,
      email,
      emailLower,
      username: user.username,
      usernameLower: user.username.toLowerCase(),
      passwordHash: hash,
      verified: true,
      verifyToken: null,
      verifyTokenExpires: null,
      resetToken: null,
      resetTokenExpires: null,
      createdAt: now,
      updatedAt: now,
    });

    await setEmail(user.id, email);
    const fresh = await loadUser(user.id);
    if (fresh) {
      fresh.auth = fresh.auth || { deviceSecrets: [] };
      fresh.auth.emailVerified = true;
      fresh.auth.passwordHash = hash;
      await saveUser(fresh);
    }
  }

  const summary = {
    userId: user.id,
    username: user.username,
    deviceSecret,
    email: opts.email ?? null,
    accountCreated: !opts.skipAccount && !!opts.email,
  };

  console.log(JSON.stringify(summary, null, 2));
  console.log("Done! JSON file created under data/users.");
  console.log("Use the deviceSecret in X-Device-Secret header when calling authenticated endpoints.");
}

main().catch((err) => {
  console.error("Failed to create user:", err);
  process.exit(1);
});