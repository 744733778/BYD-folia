import type { HexGridCoord } from './hexViewport';

// src/library/suites/grid/shared/flatGrid.ts
// 平面（2D）网格：与蜂窝布局同一套坐标接口，但按行列等距铺开。
// 卡片坐标仍然是 `HexGridCoord`（`index/baseX/baseY`），所以视口、拖拽、焦点、
// 卡片帧样式都能复用；只有坐标生成与可见性裁剪换成矩形网格的算法。

export interface FlatGridLayout {
    cols: number;
    rows: number;
    spacingX: number;
    spacingY: number;
}

export const resolveFlatGridLayout = (
    count: number,
    cols: number,
    spacingX: number,
    spacingY: number,
): FlatGridLayout => {
    const safeCols = Math.max(1, Math.floor(cols));
    return {
        cols: safeCols,
        rows: Math.ceil(Math.max(0, count) / safeCols),
        spacingX,
        spacingY,
    };
};

/**
 * 行列坐标：整体居中到原点，index 0 在左上。
 * cube 只用于保持 `toCubeKey` 唯一（平面模式下不走蜂窝裁剪，不做几何解释）。
 */
export const buildFlatGridCoords = (
    count: number,
    cols: number,
    spacingX: number,
    spacingY: number,
): HexGridCoord[] => {
    const safeCount = Math.max(0, count);
    const layout = resolveFlatGridLayout(safeCount, cols, spacingX, spacingY);
    const originX = ((layout.cols - 1) * spacingX) / 2;
    const originY = ((layout.rows - 1) * spacingY) / 2;
    const coords: HexGridCoord[] = new Array(safeCount);
    for (let index = 0; index < safeCount; index += 1) {
        const col = index % layout.cols;
        const row = Math.floor(index / layout.cols);
        coords[index] = {
            index,
            cube: { x: col, y: -col - row, z: row },
            baseX: col * spacingX - originX,
            baseY: row * spacingY - originY,
        };
    }
    return coords;
};

/**
 * 平面网格的可见下标：只在可见行里按列区间取，复杂度与屏幕上的卡数同阶，
 * 不会随着歌单变长而变慢。
 */
export const createFlatVisibleIndexResolver = (
    layout: FlatGridLayout,
    count: number,
) => {
    const { cols, spacingX, spacingY } = layout;
    return (worldX: number, worldY: number, radius: number): number[] => {
        if (count <= 0 || cols <= 0) return [];
        const minRow = Math.max(0, Math.floor((worldY - radius) / spacingY));
        const maxRow = Math.min(layout.rows - 1, Math.ceil((worldY + radius) / spacingY));
        const indexes: number[] = [];
        const radiusSq = radius * radius;
        for (let row = minRow; row <= maxRow; row += 1) {
            const centerY = row * spacingY - ((layout.rows - 1) * spacingY) / 2;
            const dy = centerY - worldY;
            const remaining = radiusSq - dy * dy;
            if (remaining <= 0) continue;
            const halfSpan = Math.sqrt(remaining);
            const minCol = Math.max(0, Math.floor((worldX - halfSpan + ((cols - 1) * spacingX) / 2) / spacingX));
            const maxCol = Math.min(cols - 1, Math.ceil((worldX + halfSpan + ((cols - 1) * spacingX) / 2) / spacingX));
            for (let col = minCol; col <= maxCol; col += 1) {
                const index = row * cols + col;
                if (index < count) indexes.push(index);
            }
        }
        indexes.sort((a, b) => a - b);
        return indexes;
    };
};
