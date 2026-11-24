import { readConfigDiagnostics } from "../config";
import { hasOwnProvider, isValidProviderName } from "../config/provider-name";
import {
  DeepLinkImportError,
  applyProviderDeepLink,
  buildProviderShareDeepLink,
  previewProviderDeepLink,
} from "../providers/deep-link-import";
import { findLiveProxy } from "../server/proxy-liveness";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  terminalSafeText,
  type RuntimeApiDeps,
} from "./runtime-api";

export const PROVIDER_DEEP_LINK_USAGE = `Usage:
  epx provider import-url <epx://...> [--preview] [--allow-private-network] [--overwrite] [--set-default] [--yes] [--json]
  epx provider share-url <provider> [--json]`;

async function shouldUseLiveProxy(deps: RuntimeApiDeps): Promise<boolean> {
  if (deps.baseUrl) return true;
  const live = await (deps.findLiveProxy ?? findLiveProxy)();
  return Boolean(live && live.role !== "client");
}

export async function handleProviderImportUrlCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const previewOnly = takeFlag(args, "--preview");
    const allowPrivateNetwork = takeFlag(args, "--allow-private-network");
    const overwrite = takeFlag(args, "--overwrite");
    const setDefault = takeFlag(args, "--set-default");
    const yes = takeFlag(args, "--yes");
    const rawUrl = args.shift()?.trim();
    rejectArgs(args, PROVIDER_DEEP_LINK_USAGE);

    if (!rawUrl) {
      throw new CliUsageError("epx:// provider URL is required", PROVIDER_DEEP_LINK_USAGE);
    }

    if (!previewOnly) {
      const refusal = (await import("./link-child")).linkChildProviderChangeRefusal("epx provider import-url");
      if (refusal) {
        if (wantsJson) console.log(JSON.stringify({ error: "link_child_refused", message: refusal }));
        else console.error(refusal);
        process.exitCode = 1;
        return;
      }
      if (!yes) {
        throw new CliUsageError("epx provider import-url requires --yes (or pass --preview to inspect)", PROVIDER_DEEP_LINK_USAGE);
      }
    }

    const useLive = await shouldUseLiveProxy(deps);
    if (previewOnly) {
      let data: unknown;
      if (useLive) {
        data = await runtimeRequest("/api/providers/import-url/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: rawUrl, allowPrivateNetwork, overwrite }),
        }, deps);
      } else {
        try {
          data = await previewProviderDeepLink(rawUrl, { allowPrivateNetwork, overwrite });
        } catch (error) {
          if (error instanceof DeepLinkImportError) throw new CliUsageError(error.message);
          throw error;
        }
      }
      const p = data as { name: string; adapter: string; baseUrl: string; canImport: boolean; maskedApiKey: string | null };
      printData(data, wantsJson, [
        `Preview provider "${terminalSafeText(p.name)}" (${terminalSafeText(p.adapter)}) -> ${terminalSafeText(p.baseUrl)} | key=${p.maskedApiKey ? terminalSafeText(p.maskedApiKey) : "none"} | canImport=${p.canImport}`,
      ]);
      return;
    }

    let data: unknown;
    if (useLive) {
      data = await runtimeRequest("/api/providers/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl, allowPrivateNetwork, overwrite, setDefault }),
      }, deps);
    } else {
      try {
        const applied = await applyProviderDeepLink(rawUrl, { allowPrivateNetwork, overwrite, setDefault });
        data = {
          schemaVersion: applied.schemaVersion,
          name: applied.name,
          adapter: applied.adapter,
          baseUrl: applied.baseUrl,
          defaultModel: applied.defaultModel,
          models: applied.models,
          hasApiKey: applied.hasApiKey,
          maskedApiKey: applied.maskedApiKey,
          allowPrivateNetwork: applied.allowPrivateNetwork,
          overwrote: applied.overwrote,
        };
      } catch (error) {
        if (error instanceof DeepLinkImportError) throw new CliUsageError(error.message);
        throw error;
      }
    }
    const r = data as { name: string; adapter: string; baseUrl: string };
    printData(data, wantsJson, [
      `Imported provider "${terminalSafeText(r.name)}" (${terminalSafeText(r.adapter)}) -> ${terminalSafeText(r.baseUrl)}.`,
    ]);
  });
}

export async function handleProviderShareUrlCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const wantsJson = takeFlag(args, "--json");
    const explicitProvider = takeOption(args, "--provider");
    const name = (explicitProvider ?? args.shift() ?? "").trim();
    rejectArgs(args, PROVIDER_DEEP_LINK_USAGE);

    if (!name || !isValidProviderName(name)) {
      throw new CliUsageError("valid provider name is required", PROVIDER_DEEP_LINK_USAGE);
    }

    let data: { schemaVersion: number; provider: string; url: string };
    if (await shouldUseLiveProxy(deps)) {
      data = await runtimeRequest(`/api/providers/share-url?${new URLSearchParams({ provider: name })}`, {}, deps) as {
        schemaVersion: number;
        provider: string;
        url: string;
      };
    } else {
      const cfg = readConfigDiagnostics().config;
      if (!hasOwnProvider(cfg.providers, name)) {
        throw new CliUsageError(`unknown provider: ${name}`);
      }
      try {
        data = {
          schemaVersion: 1,
          provider: name,
          url: buildProviderShareDeepLink(name, cfg.providers[name]!),
        };
      } catch (error) {
        if (error instanceof DeepLinkImportError) throw new CliUsageError(error.message);
        throw error;
      }
    }
    printData(data, wantsJson, [data.url]);
  });
}
