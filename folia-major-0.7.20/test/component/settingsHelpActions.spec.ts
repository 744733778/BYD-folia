import { expect, test } from './fixtures';

// test/component/settingsHelpActions.spec.ts

test.beforeEach(async ({ mount }) => {
    await mount('settingsHelpActions');
});

test('版本更新按钮打开当前 release notes，并可关闭返回 Help', async ({ page }) => {
    await page.getByTestId('help-release-notes').click();
    await expect(page.getByTestId('release-notes-dialog')).toBeVisible();
    await page.getByTestId('release-notes-close').click();
    await expect(page.getByTestId('release-notes-dialog')).toHaveCount(0);
});

// 它挂着 data-folia-keyboard-window，全局热键的 Esc 都会让路，关闭只能靠它自己的监听。
test('release notes 按 Esc 关闭', async ({ page }) => {
    await page.getByTestId('help-release-notes').click();
    await expect(page.getByTestId('release-notes-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('release-notes-dialog')).toHaveCount(0);
});

type CloseAction = { key: string } | { click: string };

/**
 * 在页面里关掉它，量出它关掉之后还在 DOM 里留了多久；3 秒还没走则返回 -1。
 *
 * 从测试端「关掉 → 等 80ms → 查还在不在」要走好几次往返，并行跑全量时这几次往返本身就能
 * 超过 240ms 的退场，于是有退场也会被判成没有。关闭和计时都在页面里做就不受往返影响。
 * 关闭也得在页面里触发：教程层在 capture 阶段把按键 stopImmediatePropagation 掉，
 * 页面里再挂监听是等不到那一下的。
 */
const lingerAfterClose = (page: import('@playwright/test').Page, testId: string, close: CloseAction) => page.evaluate(
    ({ id, action }) => new Promise<number>(resolve => {
        let closedAt = 0;
        const observer = new MutationObserver(() => {
            if (document.querySelector(`[data-testid="${id}"]`)) return;
            observer.disconnect();
            resolve(performance.now() - closedAt);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.setTimeout(() => { observer.disconnect(); resolve(-1); }, 3000);
        closedAt = performance.now();
        if ('key' in action) {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: action.key, code: action.key, bubbles: true, cancelable: true }));
        } else {
            (document.querySelector(action.click) as HTMLElement).click();
        }
    }),
    { id: testId, action: close },
);

/**
 * 覆盖层的退场靠 AnimatePresence 撑住那不到 300ms。
 *
 * 「条件为假就 return null」那种写法一关就整棵树消失，退场动画没有机会播 —— 从截图上看不出
 * 区别，只有「关掉之后它还在不在 DOM 里」这一条能把它钉住。
 */
const expectAnimatedExit = async (page: import('@playwright/test').Page, testId: string, close: CloseAction) => {
    await expect(page.getByTestId(testId)).toBeAttached();
    const lingeredMs = await lingerAfterClose(page, testId, close);
    expect(lingeredMs, `${testId} 关掉后立刻就没了，等于没有退场动画`).toBeGreaterThan(80);
    await expect(page.getByTestId(testId)).toHaveCount(0);
};

test('新版本功能页面有进出场过渡，不是直接出现和直接消失', async ({ page }) => {
    await page.getByTestId('help-release-notes').click();
    const dialog = page.getByTestId('release-notes-dialog');
    await expect(dialog).toBeAttached();
    // 入场：第一帧还没到终态。
    const enteringOpacity = await dialog.evaluate(node => Number(getComputedStyle(node).opacity));
    expect(enteringOpacity).toBeLessThan(1);

    await expect(dialog).toHaveCSS('opacity', '1', { timeout: 2000 });
    await expectAnimatedExit(page, 'release-notes-dialog', { click: '[data-testid="release-notes-close"]' });
});
