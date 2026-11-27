import type { AdapterStreamContext, IncomingMeta, ProviderAdapter } from "../../adapters/base";
import type { AdapterTierMetadata } from "../../providers/fastwire";
import { createTranslatorBudget, type TranslatorBudget } from "../../lib/translator-budget";

type TestAdapter<T extends ProviderAdapter> = Omit<T, "buildRequest" | "parseStream" | "parseResponse"> & {
  buildRequest(
    parsed: Parameters<T["buildRequest"]>[0],
    incoming?: Partial<IncomingMeta>,
  ): ReturnType<T["buildRequest"]>;
  parseStream(
    response: Response,
    budget?: TranslatorBudget,
    tierMetadata?: AdapterTierMetadata,
    streamContext?: AdapterStreamContext,
  ): ReturnType<T["parseStream"]>;
  parseResponse?: (
    response: Response,
    budget?: TranslatorBudget,
    tierMetadata?: AdapterTierMetadata,
  ) => ReturnType<NonNullable<T["parseResponse"]>>;
  dispose(): void;
};

/** Inject one bounded translator budget for a harness adapter scope. Call dispose() in finally. */
export function withHarnessTranslatorBudget<T extends ProviderAdapter>(adapter: T): TestAdapter<T> {
  const budget = createTranslatorBudget();
  const buildRequest = adapter.buildRequest.bind(adapter);
  const parseStream = adapter.parseStream.bind(adapter);
  const parseResponse = adapter.parseResponse?.bind(adapter);
  let disposed = false;
  return {
    ...adapter,
    buildRequest(parsed: Parameters<T["buildRequest"]>[0], incoming?: Partial<IncomingMeta>) {
      return buildRequest(parsed, {
        ...incoming,
        headers: incoming?.headers ?? new Headers(),
        translatorBudget: incoming?.translatorBudget ?? budget,
      });
    },
    parseStream(
      response: Response,
      explicitBudget?: TranslatorBudget,
      tierMetadata?: AdapterTierMetadata,
      streamContext?: AdapterStreamContext,
    ) {
      return parseStream(response, explicitBudget ?? budget, tierMetadata, streamContext);
    },
    ...(parseResponse ? {
      parseResponse(
        response: Response,
        explicitBudget?: TranslatorBudget,
        tierMetadata?: AdapterTierMetadata,
      ) {
        return parseResponse(response, explicitBudget ?? budget, tierMetadata);
      },
    } : {}),
    dispose() {
      if (disposed) return;
      disposed = true;
      budget.dispose();
    },
  } as unknown as TestAdapter<T>;
}
