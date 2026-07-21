import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  BetterSqlite3LoadError,
  formatBetterSqlite3AbiError,
  isNativeModuleAbiMismatch,
  loadBetterSqlite3,
  resolveBetterSqlite3PackageRoot,
} from "../../src/store/sqlite-native.js";

const require = createRequire(import.meta.url);

type RequireCache = Record<string, unknown>;

function fakeRequire(
  impl: (id: string) => unknown,
  resolveImpl: (id: string) => string,
): NodeRequire {
  return Object.assign(impl, {
    resolve: resolveImpl,
    cache: {} as RequireCache,
  }) as NodeRequire;
}

describe("sqlite-native loader", () => {
  it("detects NODE_MODULE_VERSION ABI mismatch errors", () => {
    assert.equal(
      isNativeModuleAbiMismatch(
        new Error(
          "The module '/tmp/better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 115",
        ),
      ),
      true,
    );
    assert.equal(isNativeModuleAbiMismatch(new Error("SQLITE_BUSY")), false);
  });

  it("detects ERR_DLOPEN_FAILED codes", () => {
    const err = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });
    assert.equal(isNativeModuleAbiMismatch(err), true);
  });

  it("resolves the installed better-sqlite3 package root", () => {
    const root = resolveBetterSqlite3PackageRoot(require);
    assert.ok(root);
    assert.equal(path.basename(root!), "better-sqlite3");
  });

  it("loads better-sqlite3 successfully in the current runtime", () => {
    const Database = loadBetterSqlite3({ requireImpl: require, allowRebuild: false });
    const db = new (Database as new (path: string) => {
      exec: (sql: string) => void;
      close: () => void;
    })(":memory:");
    db.exec("SELECT 1");
    db.close();
  });

  it("rebuilds once on ABI mismatch then succeeds", () => {
    let calls = 0;
    const ctor = class FakeDb {
      constructor(_path: string) {}
    };
    const req = fakeRequire(
      (id: string) => {
        assert.equal(id, "better-sqlite3");
        calls += 1;
        if (calls === 1) {
          throw new Error(
            "was compiled against a different Node.js version using NODE_MODULE_VERSION 115. Please try re-compiling",
          );
        }
        return ctor;
      },
      (id: string) => {
        assert.equal(id, "better-sqlite3");
        return path.join("/tmp/fake-npm/node_modules/better-sqlite3/lib/index.js");
      },
    );

    let rebuilt = false;
    const Database = loadBetterSqlite3({
      requireImpl: req,
      rebuild: (packageRoot) => {
        rebuilt = true;
        assert.equal(packageRoot, "/tmp/fake-npm/node_modules/better-sqlite3");
        return { ok: true, detail: "rebuilt" };
      },
    });

    assert.equal(Database, ctor);
    assert.equal(rebuilt, true);
    assert.equal(calls, 2);
  });

  it("throws BetterSqlite3LoadError with recovery guidance when rebuild fails", () => {
    const req = fakeRequire(
      (_id: string) => {
        throw new Error(
          "The module 'x.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 108",
        );
      },
      () => path.join("/tmp/fake-npm/node_modules/better-sqlite3/lib/index.js"),
    );

    assert.throws(
      () =>
        loadBetterSqlite3({
          requireImpl: req,
          rebuild: () => ({ ok: false, detail: "npm missing" }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof BetterSqlite3LoadError);
        const message = error.message;
        assert.match(message, /pi-hermes-memory could not load the native better-sqlite3 module/);
        assert.match(message, /npm rebuild better-sqlite3/);
        assert.match(message, /Homebrew/);
        assert.match(message, /npm missing/);
        assert.equal(error.packageRoot, "/tmp/fake-npm/node_modules/better-sqlite3");
        return true;
      },
    );
  });

  it("formats actionable ABI recovery text", () => {
    const message = formatBetterSqlite3AbiError({
      originalError: new Error("NODE_MODULE_VERSION 115"),
      packageRoot: "/Users/me/.pi/agent/npm/node_modules/better-sqlite3",
      rebuildAttempted: true,
      rebuildDetail: "exit 1",
    });
    assert.match(message, /NODE_MODULE_VERSION/);
    assert.match(message, /\/Users\/me\/\.pi\/agent\/npm\/node_modules\/better-sqlite3/);
    assert.match(message, /npm rebuild better-sqlite3/);
    assert.match(message, /Homebrew/);
  });

  it("does not rebuild for non-ABI load failures", () => {
    let rebuilt = false;
    const req = fakeRequire(
      () => {
        throw new Error("Cannot find module 'better-sqlite3'");
      },
      () => {
        throw new Error("not found");
      },
    );

    assert.throws(
      () =>
        loadBetterSqlite3({
          requireImpl: req,
          rebuild: () => {
            rebuilt = true;
            return { ok: true, detail: "should not run" };
          },
        }),
      /Cannot find module 'better-sqlite3'/,
    );
    assert.equal(rebuilt, false);
  });
});
