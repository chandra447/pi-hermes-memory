# Project-Local Memory — Design Spec

> Date: 2026-06-12
> Status: Approved
> Target: v0.8.0

## Problem

`pi install npm:pi-hermes-memory` 是全局安装，所有记忆放在 `~/.pi/agent/pi-hermes-memory/`，污染用户 home 目录。用户希望：

1. 在特定项目文件夹中安装 hermes（项目级 extension）
2. 所有记忆留在项目中，不碰 `~/.pi`
3. 离开项目时 hermes 不激活（由 Pi 自动处理）
4. 全局安装的用户零感知，体感完全不变

## Solution

新增 `detectMemoryRoot()` 函数：从 extension 入口文件路径反推记忆根目录。项目级安装用 `<project>/.pi/hermes-memory/`，全局安装用 `~/.pi/agent/pi-hermes-memory/`。

用户通过 `pi install -l npm:pi-hermes-memory` 实现项目级安装（Pi 原生支持）。

## Architecture

```
入口文件路径
    │
    ▼
detectMemoryRoot(import.meta.url)
    │
    ├── 全局安装: ~/.pi/agent/extensions/npm/pi-hermes-memory/src/index.ts
    │       → 搜索到 .pi/agent/
    │       → 记忆根: ~/.pi/agent/pi-hermes-memory/
    │
    └── 项目级安装: <proj>/.pi/extensions/npm/pi-hermes-memory/src/index.ts
            → 搜索到 .pi/
            → 记忆根: <proj>/.pi/hermes-memory/
```

**不改动任何 handler、tool、command、配置、event 处理。**

## Files Changed

### 1. `src/paths.ts` — 新增 `detectMemoryRoot()`

```typescript
import { existsSync } from "node:fs";

/**
 * 从 extension 入口文件路径检测记忆根目录。
 *
 * 全局安装: ~/.pi/agent/extensions/.../index.ts
 *   → 记忆根: ~/.pi/agent/pi-hermes-memory/
 * 项目级安装: <proj>/.pi/extensions/.../index.ts
 *   → 记忆根: <proj>/.pi/hermes-memory/
 */
export function detectMemoryRoot(entryFile: string): string {
  let dir = path.dirname(entryFile);
  while (dir !== path.dirname(dir)) {
    const piDir = path.join(dir, ".pi");
    if (existsSync(piDir)) {
      return path.join(piDir, "hermes-memory");
    }
    dir = path.dirname(dir);
  }
  // 回退到全局默认（不应到达，但保守处理）
  return path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory");
}
```

### 2. `src/index.ts` — 入口处替换路径逻辑

**修改前：**
```typescript
const agentRoot = AGENT_ROOT;
const legacyGlobalDir = path.join(agentRoot, "memory");
const defaultGlobalDir = path.join(agentRoot, "pi-hermes-memory");
const configuredMemoryDir = config.memoryDir?.trim();
const pointsToLegacyMemoryDir = configuredMemoryDir
  ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
  : false;
const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
  ? defaultGlobalDir
  : configuredMemoryDir;
const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;
```

**修改后：**
```typescript
const baseDir = detectMemoryRoot(import.meta.url);
// agentRoot = .pi 目录（全局: ~/.pi/agent, 项目级: <proj>/.pi）
const agentRoot = path.dirname(baseDir);
const legacyGlobalDir = path.join(agentRoot, "memory");
const shouldMigrateExtensionRoot = true; // 始终尝试迁移（项目级无旧数据，无害）
```

然后将文件中所有 `globalDir` 替换为 `baseDir`。

| 原变量 | 新值 | 说明 |
|--------|------|------|
| `AGENT_ROOT` 常量 | `path.dirname(baseDir)` | 从 .pi 目录自动推导 |
| `legacyGlobalDir` | 保留，用新 `agentRoot` 推导 | 项目级时指向 `<proj>/.pi/memory`（无害） |
| `defaultGlobalDir` + `configuredMemoryDir` 逻辑 | `detectMemoryRoot()` | 路径不再可配 |
| `globalDir` | `baseDir` | 语义一致，来源变了 |

## Installation (README Update)

```markdown
## Quick Start

# 全局安装（所有项目共享记忆）
pi install npm:pi-hermes-memory

# 项目级安装（记忆留在项目 .pi/hermes-memory/ 中）
pi install -l npm:pi-hermes-memory
```

## Behavior Matrix

| 安装方式 | 命令 | 记忆根目录 | 激活范围 | 原有用户感知 |
|----------|------|-----------|----------|:--:|
| 全局 | `pi install npm:pi-hermes-memory` | `~/.pi/agent/pi-hermes-memory/` | 所有项目 | 完全不变 |
| 项目级 | `pi install -l npm:pi-hermes-memory` | `<proj>/.pi/hermes-memory/` | 仅该项目 | 新增功能 |

## What Does NOT Change

- ✅ 所有 handler、tool、command：零改动
- ✅ 双层记忆（global + project）：零改动
- ✅ SkillStore、DatabaseManager：零改动
- ✅ 配置系统（hermes-memory-config.json）：零改动
- ✅ content-scanner、memory-tool、skill-tool：零改动
- ✅ 全局安装用户体验：完全不变

## Testing

- 现有测试：入口处的 `MemoryStore` 构造函数接收 `memoryDir` 配置，通过 mock `detectMemoryRoot` 保持现有测试通过
- 新增测试：`tests/paths.test.ts` 中验证 `detectMemoryRoot` 的项目级 vs 全局路径检测

## Implementation Notes

- `import.meta.url` 在 jiti 中返回 `file://` URL，需 `fileURLToPath()` 转换
- `detectMemoryRoot()` 需引入 `existsSync` from `node:fs`
- `agentRoot` = `path.dirname(baseDir)`，全局时为 `~/.pi/agent`，项目级时为 `<proj>/.pi`
- `shouldMigrateExtensionRoot` 恒为 `true`：全局时迁移旧数据，项目级时无害 no-op
- `legacyGlobalDir` = `path.join(agentRoot, "memory")`：项目级时指向 `<proj>/.pi/memory`，SkillStore 迁移忽略不存在的目录

## Risk Assessment

| 风险 | 缓解 |
|------|------|
| `import.meta.url` 在 jiti 中返回 `file://` URL | 用 `fileURLToPath` 转换 |
| 入口文件路径不包含 `.pi/` | 回退到 `~/.pi/agent/pi-hermes-memory/` |
| `existsSync` 同步 I/O | 入口处只调用一次，不影响运行时性能 |
| SkillStore 用项目级 `legacyGlobalDir`（不存在的路径）| SkillStore 迁移是 best-effort，不存在则跳过 |
