/* eslint-disable no-console */

import { runTagger } from './cli.js';

/**
 * Run tagger with argv array (already stripped of node + script path).
 */
export async function run(argv: string[]): Promise<void> {
  await runTagger(argv);
}
