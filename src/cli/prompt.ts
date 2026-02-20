/**
 * Simple interactive prompt utilities for the CLI wizard.
 * Uses Node.js readline — no external dependencies.
 */

import * as readline from 'node:readline';

export interface PromptIO {
  question(query: string): Promise<string>;
  close(): void;
}

/** Create a readline-based prompt IO. */
export function createPromptIO(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): PromptIO {
  const rl = readline.createInterface({ input, output });

  return {
    question(query: string): Promise<string> {
      return new Promise((resolve) => {
        rl.question(query, (answer) => resolve(answer.trim()));
      });
    },
    close(): void {
      rl.close();
    },
  };
}

/**
 * Ask user to select one or more options from a numbered list.
 * Returns the selected option values.
 */
export async function promptSelect(
  io: PromptIO,
  message: string,
  options: { label: string; value: string }[],
  multi: boolean = false,
): Promise<string[]> {
  console.log(`\n${message}`);
  options.forEach((opt, i) => {
    console.log(`  ${i + 1}) ${opt.label}`);
  });

  const hint = multi
    ? 'Enter numbers separated by commas (e.g., 1,2): '
    : 'Enter number: ';

  while (true) {
    const answer = await io.question(hint);
    const parts = answer.split(',').map((s) => s.trim()).filter(Boolean);
    const indices = parts.map((p) => parseInt(p, 10) - 1);

    if (indices.length === 0) {
      console.log('Please select at least one option.');
      continue;
    }

    if (indices.some((i) => isNaN(i) || i < 0 || i >= options.length)) {
      console.log(`Please enter a number between 1 and ${options.length}.`);
      continue;
    }

    if (!multi && indices.length > 1) {
      console.log('Please select only one option.');
      continue;
    }

    return indices.map((i) => options[i].value);
  }
}

/**
 * Ask user for a text input with optional validation.
 */
export async function promptText(
  io: PromptIO,
  message: string,
  validate?: (input: string) => string | null,
): Promise<string> {
  while (true) {
    const answer = await io.question(`${message}: `);

    if (!answer) {
      console.log('Input cannot be empty.');
      continue;
    }

    if (validate) {
      const error = validate(answer);
      if (error) {
        console.log(error);
        continue;
      }
    }

    return answer;
  }
}

/**
 * Ask a yes/no question. Returns true for yes.
 */
export async function promptConfirm(
  io: PromptIO,
  message: string,
  defaultYes: boolean = true,
): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await io.question(`${message} ${hint}: `);

  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}
