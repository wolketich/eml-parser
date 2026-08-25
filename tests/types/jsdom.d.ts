declare module "jsdom" {
  export class VirtualConsole {
    on(event: string, listener: (error: Error) => void): this;
  }

  export class JSDOM {
    constructor(
      html?: string,
      options?: {
        runScripts?: "dangerously" | "outside-only";
        resources?: "usable";
        url?: string;
        virtualConsole?: VirtualConsole;
        beforeParse?: (window: Window & typeof globalThis) => void;
      },
    );

    window: Window & typeof globalThis;
  }
}
