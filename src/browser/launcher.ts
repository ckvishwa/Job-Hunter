import { chromium, type BrowserContext, type LaunchOptions } from "playwright";

export interface LaunchPersistentChromeOptions extends LaunchOptions {
  headless?: boolean;
}

const DEFAULT_USER_DATA_DIR = "./.chrome-profile";

/**
 * Launches a persistent Chrome context so cookies/logins survive across runs.
 * Headless defaults to false — never bypass the visible-browser requirement
 * unless a caller explicitly overrides it.
 */
export async function launchPersistentChrome(
  userDataDir: string = DEFAULT_USER_DATA_DIR,
  options: LaunchPersistentChromeOptions = {},
): Promise<BrowserContext> {
  const { headless = false, ...rest } = options;
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless,
    ...rest,
  });
}
