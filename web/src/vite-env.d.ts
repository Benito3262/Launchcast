/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAUNCHCAST_ADDRESS?: string;
  readonly VITE_LAUNCHCAST_V2_ADDRESS?: string;
  readonly VITE_ROBINHOOD_TESTNET_RPC?: string;
  readonly VITE_REOWN_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: {
    request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
    on?(event: string, listener: (...args: unknown[]) => void): void;
    removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  };
}
