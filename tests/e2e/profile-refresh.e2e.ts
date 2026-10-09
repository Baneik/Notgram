import { expect, test, type Page } from "@playwright/test";
import type { telegramStore as Store } from "../../src/store/telegramStore";

type DownloadControl = Window & {
  profilePhotoRequests: number[];
  releaseProfilePhotos: () => void;
  profilePhotosFinished: number;
};

const openDelayedAvatar = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "查看 产品讨论 资料" }).click();
  const profile = page.getByRole("dialog", { name: "资料" });
  await profile.getByRole("button", { name: /成员\s*查看群组成员/ }).click();
  await profile.locator(".profile-member-identity").filter({ hasText: "Mia Chen" }).click();
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: typeof Store };
    const scope = window as unknown as DownloadControl;
    scope.profilePhotoRequests = [];
    scope.profilePhotosFinished = 0;
    const pending = new Promise<void>(resolve => { scope.releaseProfilePhotos = resolve; });
    const state = telegramStore.getState();
    const value = state.profile.value!;
    telegramStore.setState({
      cacheFile: async (_fileId, priority) => {
        scope.profilePhotoRequests.push(priority ?? 0);
        await pending;
        scope.profilePhotosFinished += 1;
      },
      profile: { ...state.profile, value: { ...value, profilePhotos: [{
        ...value.profilePhotos![0],
        content: { ...value.profilePhotos![0].content, fileId: 5001,
          localPath: undefined, previewDataUrl: undefined, thumbnailPath: undefined,
          canDownload: true, isDownloaded: false, isDownloading: false },
      }] } },
    });
  });
  const popup = page.waitForEvent("popup");
  await profile.getByRole("button", { name: "查看 Mia Chen 的头像和历史头像" }).click();
  const viewer = await popup;
  await expect(viewer.getByRole("dialog", { name: /^图片查看器：/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as DownloadControl).profilePhotoRequests)).toContain(32);
  return { profile, viewer };
};

const finishPhotos = async (page: Page) => {
  await page.evaluate(() => (window as unknown as DownloadControl).releaseProfilePhotos());
  await expect.poll(() => page.evaluate(() => {
    const scope = window as unknown as DownloadControl;
    return scope.profilePhotosFinished === scope.profilePhotoRequests.length;
  })).toBe(true);
  // Flush the download callbacks and the React updates they can schedule.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
};

for (const explicitDownload of [false, true]) {
  test(`${explicitDownload ? "explicit" : "automatic"} avatar downloads cannot reopen a closed profile`, async ({ page }) => {
    const { profile, viewer } = await openDelayedAvatar(page);
    if (explicitDownload) {
      await viewer.getByRole("button", { name: "下载原图", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as DownloadControl).profilePhotoRequests)).toContain(24);
    }
    await viewer.close();
    await profile.getByRole("button", { name: "关闭资料" }).click();
    await expect(profile).toBeHidden();
    await finishPhotos(page);
    await expect(profile).toBeHidden();
    expect(await page.evaluate(async () => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: typeof Store };
      return telegramStore.getState().profile.target;
    })).toBeUndefined();
  });
}

test("late avatar downloads cannot replace another member profile", async ({ page }) => {
  const { profile, viewer } = await openDelayedAvatar(page);
  await viewer.close();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: typeof Store };
    await telegramStore.getState().loadUserProfile("u-jules");
  });
  await expect(profile.getByRole("heading", { name: "Jules" })).toBeVisible();
  await finishPhotos(page);
  await expect(profile.getByRole("heading", { name: "Jules" })).toBeVisible();
});

for (const transition of ["reopen", "round-trip"] as const) {
  test(`avatar refresh callbacks expire after a profile ${transition}`, async ({ page }) => {
    const { profile, viewer } = await openDelayedAvatar(page);
    await viewer.close();
    if (transition === "reopen") {
      await profile.getByRole("button", { name: "关闭资料" }).click();
      await expect(profile).toBeHidden();
    } else {
      await page.evaluate(async () => {
        const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: typeof Store };
        await telegramStore.getState().loadUserProfile("u-jules");
      });
      await expect(profile.getByRole("heading", { name: "Jules" })).toBeVisible();
    }
    await page.evaluate(async () => {
      const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: typeof Store };
      await telegramStore.getState().loadUserProfile("u-mia");
      const value = telegramStore.getState().profile.value!;
      telegramStore.setState({ profile: { ...telegramStore.getState().profile,
        value: { ...value, bio: "new profile session" } } });
    });
    await expect(profile.getByText("new profile session", { exact: true })).toBeVisible();
    await finishPhotos(page);
    await expect(profile.getByText("new profile session", { exact: true })).toBeVisible();
  });
}

test("avatar refresh callbacks expire when the account changes", async ({ page }) => {
  const { profile, viewer } = await openDelayedAvatar(page);
  await viewer.close();
  await page.evaluate(async () => {
    const { telegramStore } = await (0, eval)('import("/src/store/telegramStore.ts")') as { telegramStore: typeof Store };
    telegramStore.setState({ activeAccountId: "new-profile-account", profile: { loading: false } });
  });
  await expect(profile).toBeHidden();
  await finishPhotos(page);
  await expect(profile).toBeHidden();
});

test("avatar downloads still refresh the profile and its viewer while open", async ({ page }) => {
  const { profile, viewer } = await openDelayedAvatar(page);
  await finishPhotos(page);
  await expect(profile.getByRole("heading", { name: "Mia Chen" })).toBeVisible();
  await expect(viewer.locator(".media-viewer-image")).toBeVisible();
  await viewer.close();
});
