/**
 * Interactive prompt utilities for the CLI wizard.
 *
 * Uses @clack/prompts for beautiful interactive prompts when running in a real terminal.
 * Falls back to the PromptIO interface for testing (mock injection).
 */

import * as readline from 'node:readline';
import * as clack from '@clack/prompts';

export interface PromptIO {
  question(query: string): Promise<string>;
  close(): void;
}

/** Create a readline-based prompt IO (used when tests inject a custom IO). */
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
 * When io is null, uses @clack/prompts for interactive selection.
 * Returns the selected option values.
 */
export async function promptSelect(
  io: PromptIO | null,
  message: string,
  options: { label: string; value: string }[],
  multi: boolean = false,
): Promise<string[]> {
  // Use @clack/prompts for real terminal interaction
  if (!io) {
    if (multi) {
      const result = await clack.multiselect({
        message,
        options: options.map((opt) => ({ label: opt.label, value: opt.value })),
      });
      if (clack.isCancel(result)) {
        clack.cancel('Setup cancelled.');
        process.exit(0);
      }
      return result as string[];
    }
    const result = await clack.select({
      message,
      options: options.map((opt) => ({ label: opt.label, value: opt.value })),
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    return [result as string];
  }

  // Fallback: numbered list (for testing with mock IO)
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
 * When io is null, uses @clack/prompts.
 */
export async function promptText(
  io: PromptIO | null,
  message: string,
  validate?: (input: string) => string | null,
): Promise<string> {
  // Use @clack/prompts for real terminal interaction
  if (!io) {
    const result = await clack.text({
      message,
      validate: (value) => {
        if (!value) return 'Input cannot be empty.';
        if (validate) {
          const error = validate(value);
          if (error) return error;
        }
        return undefined;
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    return result as string;
  }

  // Fallback for testing
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
 * When io is null, uses @clack/prompts.
 */
export async function promptConfirm(
  io: PromptIO | null,
  message: string,
  defaultYes: boolean = true,
): Promise<boolean> {
  if (!io) {
    const result = await clack.confirm({
      message,
      initialValue: defaultYes,
    });
    if (clack.isCancel(result)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    return result as boolean;
  }

  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = await io.question(`${message} ${hint}: `);

  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}
