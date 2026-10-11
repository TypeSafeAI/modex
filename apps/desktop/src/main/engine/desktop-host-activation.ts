interface DesktopHostActivationOptions {
  available: () => boolean;
  start: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** A launch request starts only the listener; its clients still need native approval. */
export function createDesktopHostActivation(options: DesktopHostActivationOptions) {
  let initialized = false;
  let requested = false;
  const flush = async () => {
    if (!initialized || !requested) return;
    requested = false;
    if (options.available()) await options.start();
  };
  return {
    open(url: string): boolean {
      // No parameters, credentials, commands or alternate URL spellings are accepted.
      if (url !== "modex-host://connect" || !options.available()) return false;
      requested = true;
      void flush().catch(options.onError);
      return true;
    },
    ready(): void {
      initialized = true;
      void flush().catch(options.onError);
    },
  };
}
