import { expect, test, type Page } from "../support/fixtures";
import { expectComposerVisible } from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function openMockAgent(page: Page, options?: { initialPrompt?: string }) {
  await page.setViewportSize(MOBILE_VIEWPORT);
  const session = await seedMockAgentWorkspace({
    repoPrefix: "provider-usage-tooltip-",
    title: "Provider usage tooltip e2e",
    initialPrompt: options?.initialPrompt,
  });
  await openAgentRoute(page, session);
  await expectComposerVisible(page);
  await expect(page.getByTestId("context-window-meter")).toBeVisible({ timeout: 30_000 });
  return session;
}

const GROK_SHAPED_USAGE = {
  providerId: "mock",
  displayName: "Grok",
  status: "available" as const,
  planLabel: null,
  windows: [],
  balances: [
    {
      id: "monthly_credits",
      label: "Monthly credits",
      used: 37886,
      remaining: 112114,
      limit: 150000,
      unit: "credits" as const,
    },
  ],
};

test.describe("provider usage tooltip", () => {
  test("fetches usage when the context tooltip opens and renders the active provider", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [
              {
                id: "session",
                label: "Session",
                usedPct: 42,
                remainingPct: 58,
                resetsAt: "2026-06-19T05:00:00.000Z",
              },
            ],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page, {
      initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
    });
    try {
      expect(usageFixture.requestCount()).toBe(0);

      await page.getByTestId("context-window-meter").hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Test plan")).toBeVisible();
      await expect(page.getByText("Session", { exact: true })).toBeVisible();
      await expect(page.getByText("42%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("refreshes usage again each time the tooltip is shown", async ({ page }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 41 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 64 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page, {
      initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
    });
    try {
      const meter = page.getByTestId("context-window-meter");

      await meter.hover();
      await usageFixture.waitForRequestCount(1);
      await expect(page.getByText("41%")).toBeVisible({ timeout: 10_000 });

      await page.mouse.move(0, 0);
      await expect(page.getByText("Mock provider", { exact: true })).toHaveCount(0);

      await meter.hover();
      await usageFixture.waitForRequestCount(2);
      expect(usageFixture.requestCount()).toBe(2);
      await expect(page.getByText("64%")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("shows the Usage control and Grok-shaped plan usage when context window usage is unknown", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [GROK_SHAPED_USAGE],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const usageControl = page.getByTestId("context-window-meter");
      await expect(usageControl).toHaveAttribute("aria-label", "Usage");

      await usageControl.hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Context window", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
      await expect(page.getByText("Grok", { exact: true })).toBeVisible();
      await expect(page.getByText("Monthly credits")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("keeps the circular context meter and plan usage when context window values exist", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "mock",
            displayName: "Mock provider",
            status: "available",
            planLabel: "Test plan",
            windows: [{ id: "session", label: "Session", usedPct: 42 }],
          },
        ],
      },
    ]);
    const session = await openMockAgent(page, {
      initialPrompt: "emit 1 coalesced agent stream update for provider usage tooltip.",
    });
    try {
      const usageControl = page.getByTestId("context-window-meter");
      await expect(usageControl).toHaveAttribute("aria-label", /Context window \d+% used/);

      await usageControl.hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("Context window", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Mock provider", { exact: true })).toBeVisible();
      await expect(page.getByText("Test plan")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });

  test("shows No usage data when neither context window usage nor plan usage exists", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [],
      },
    ]);
    const session = await openMockAgent(page);
    try {
      const usageControl = page.getByTestId("context-window-meter");
      await usageControl.hover();
      await usageFixture.waitForRequestCount(1);

      await expect(page.getByText("No usage data")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Context window", { exact: true })).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });

  test("keeps the Usage control and Host-upgrade explanation when the Host lacks plan usage", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installProviderUsageFixture(
      page,
      [
        {
          fetchedAt: "2026-06-19T00:00:00.000Z",
          providers: [],
        },
      ],
      { advertiseProviderUsage: false },
    );
    const session = await openMockAgent(page);
    try {
      const usageControl = page.getByTestId("context-window-meter");
      await expect(usageControl).toBeVisible();
      await usageControl.hover();

      await expect(page.getByText("Context window", { exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
      await expect(page.getByText("Update the host to see provider usage")).toBeVisible();
    } finally {
      await session.cleanup();
    }
  });
});
