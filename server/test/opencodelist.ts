/*
 * Preload: no test may spawn the real `opencode models`. A worker start reads the
 * engine's list before it plans (primeOpencodeModels), and on a machine with the
 * CLI installed that spawn hung a full server tranche for 14 minutes. Tests share
 * one process and some files reset the list, so every test starts with an empty
 * seeded list; a suite that needs names seeds its own in a nested beforeEach.
 */
import { afterAll, beforeEach } from "bun:test";
import { __resetEngineModels, __seedOpencodeModels } from "../src/enginemodels.ts";

beforeEach(() => __seedOpencodeModels([]));
afterAll(() => __resetEngineModels());
