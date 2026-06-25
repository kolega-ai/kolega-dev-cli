import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import open from "open";

import { ApiClient, buildUserAgent } from "../api/client.js";
import { pollForDeviceToken, requestDeviceCode } from "../api/auth-device-flow.js";
import { getQuotaBalance } from "../api/quotas.js";
import { getMe } from "../api/me.js";
import { clearConfig, readConfig, resolveActiveToken, writeConfig } from "../config/store.js";
import { box, redactToken } from "../ui/tty.js";
import { handleError } from "../ui/errors.js";
import { renderJson } from "../ui/render.js";
import { DEFAULT_API_URL, type GlobalOptions } from "./context.js";

const CLIENT_NAME_PREFIX = "kolega-cli/";

export function registerAuthCommands(program: Command, pkgVersion: string): void {
  const auth = program.command("auth").description("Authenticate against the Kolega API");

  auth
    .command("login")
    .description("Pair this machine with your Kolega organization")
    .option("--token <token>", "use an API key directly (kcp_live_…); skips the device flow")
    .action(async (opts: { token?: string }, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const baseUrl = globals.apiUrl ?? process.env.KOLEGA_API_URL ?? DEFAULT_API_URL;

        if (opts.token) {
          await loginWithToken(baseUrl, opts.token, pkgVersion, Boolean(globals.json));
          return;
        }

        await loginWithDeviceFlow(baseUrl, pkgVersion, Boolean(globals.json));
      } catch (err) {
        handleError(err);
      }
    });

  auth
    .command("status")
    .description("Show the currently-stored token and how it was obtained")
    .action(async (_opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const active = await resolveActiveToken();
        if (!active.token) {
          if (globals.json) {
            renderJson({ authenticated: false });
          } else {
            process.stdout.write(
              chalk.dim("Not authenticated. Run ") +
                chalk.cyan("kolega auth login") +
                chalk.dim(".\n"),
            );
          }
          process.exit(4);
        }

        const baseUrl =
          globals.apiUrl ?? process.env.KOLEGA_API_URL ?? active.baseUrl ?? DEFAULT_API_URL;
        const client = new ApiClient({
          baseUrl,
          token: active.token,
          userAgent: buildUserAgent(pkgVersion),
        });
        const [balance, me] = await Promise.all([getQuotaBalance(client), getMe(client)]);
        const sourceLabel =
          active.source === "env"
            ? "KOLEGA_TOKEN environment variable"
            : active.via === "token_flag"
              ? "--token flag (API key)"
              : "device flow";
        const scopes =
          me.api_key.scopes && me.api_key.scopes.length > 0
            ? me.api_key.scopes.join(", ")
            : "full access (unscoped key)";

        if (globals.json) {
          renderJson({
            authenticated: true,
            token: redactToken(active.token),
            source: active.source,
            via: active.via,
            base_url: baseUrl,
            organization: {
              id: me.organization_id,
              name: me.organization_name,
              slug: me.organization_slug,
            },
            api_key: me.api_key,
            period_start: balance.period_start,
            period_end: balance.period_end,
          });
          return;
        }

        process.stdout.write(chalk.green("Authenticated ✓\n"));
        process.stdout.write(`  Organization  ${me.organization_name} (${me.organization_slug})\n`);
        process.stdout.write(`  API key       ${me.api_key.name} [${me.api_key.key_prefix}]\n`);
        process.stdout.write(`  Scopes        ${scopes}\n`);
        process.stdout.write(`  Token         ${redactToken(active.token)}\n`);
        process.stdout.write(`  Source        ${sourceLabel}\n`);
        process.stdout.write(`  Base URL      ${baseUrl}\n`);
        process.stdout.write(`  Period        ${balance.period_start} → ${balance.period_end}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  auth
    .command("logout")
    .description("Remove the stored token from the config file")
    .action(async (_opts, cmd) => {
      try {
        const globals = (cmd.parent?.parent?.opts() as GlobalOptions | undefined) ?? {};
        const existed = (await readConfig()) !== null;
        await clearConfig();
        if (globals.json) {
          renderJson({ logged_out: true, existed });
          return;
        }
        if (existed) {
          process.stdout.write(chalk.green("Logged out.\n"));
        } else {
          process.stdout.write(chalk.dim("No stored credentials to remove.\n"));
        }
      } catch (err) {
        handleError(err);
      }
    });
}

async function loginWithToken(
  baseUrl: string,
  token: string,
  pkgVersion: string,
  asJson: boolean,
): Promise<void> {
  const client = new ApiClient({
    baseUrl,
    token,
    userAgent: buildUserAgent(pkgVersion),
  });
  const spinner = asJson ? null : ora("Validating token against the API…").start();
  let me;
  try {
    me = await getMe(client);
  } catch (err) {
    spinner?.fail("Token rejected");
    throw err;
  }
  spinner?.succeed("Token validated");
  await writeConfig({
    token,
    baseUrl,
    obtainedVia: "token_flag",
    savedAt: new Date().toISOString(),
  });
  if (asJson) {
    renderJson({
      logged_in: true,
      via: "token_flag",
      organization: {
        id: me.organization_id,
        name: me.organization_name,
        slug: me.organization_slug,
      },
    });
    return;
  }
  process.stdout.write(
    chalk.green(`Logged in to ${me.organization_name}. `) + chalk.dim(`(${redactToken(token)})\n`),
  );
}

async function loginWithDeviceFlow(
  baseUrl: string,
  pkgVersion: string,
  asJson: boolean,
): Promise<void> {
  const client = new ApiClient({
    baseUrl,
    token: "",
    userAgent: buildUserAgent(pkgVersion),
  });

  const device = await requestDeviceCode(client, `${CLIENT_NAME_PREFIX}${pkgVersion}`);

  if (!asJson) {
    process.stdout.write("\n");
    process.stdout.write(box([`User code:  ${device.user_code}`]) + "\n\n");
    process.stdout.write(chalk.dim("Open this URL to approve the pairing:\n"));
    process.stdout.write(`  ${chalk.cyan(device.verification_uri_complete)}\n`);
    process.stdout.write(chalk.dim("or paste the code at:\n"));
    process.stdout.write(`  ${chalk.cyan(device.verification_uri)}\n\n`);
  }

  // Fire and forget — some environments have no browser (SSH, CI). We
  // swallow errors because the fallback URL is already printed above.
  if (!asJson) {
    try {
      await open(device.verification_uri_complete);
    } catch {
      // ignored
    }
  }

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  const spinner = asJson
    ? null
    : ora("Waiting for you to approve the pairing in the browser…").start();
  try {
    const token = await pollForDeviceToken({
      client,
      deviceCode: device.device_code,
      interval: device.interval,
      expiresIn: device.expires_in,
      signal: controller.signal,
    });
    spinner?.succeed("Paired");

    await writeConfig({
      token: token.access_token,
      baseUrl,
      obtainedVia: "device_flow",
      savedAt: new Date().toISOString(),
    });

    // Confirm the token works and (implicitly) fetch the org-scoped balance.
    const authedClient = new ApiClient({
      baseUrl,
      token: token.access_token,
      userAgent: buildUserAgent(pkgVersion),
    });
    const [balance, me] = await Promise.all([getQuotaBalance(authedClient), getMe(authedClient)]);

    if (asJson) {
      renderJson({
        logged_in: true,
        via: "device_flow",
        organization: {
          id: me.organization_id,
          name: me.organization_name,
          slug: me.organization_slug,
        },
        period_start: balance.period_start,
        period_end: balance.period_end,
      });
      return;
    }
    process.stdout.write(
      chalk.green(`\nLogged in to ${me.organization_name}. `) +
        chalk.dim(`(${redactToken(token.access_token)})\n`),
    );
    process.stdout.write(
      chalk.dim(`Quota period: ${balance.period_start} → ${balance.period_end}\n`),
    );
  } catch (err) {
    spinner?.fail("Pairing failed");
    throw err;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
