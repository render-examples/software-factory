import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

let rl: readline.Interface | undefined;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input, output });
  }
  return rl;
}

export function closePrompt(): void {
  rl?.close();
  rl = undefined;
}

export async function ask(question: string): Promise<string> {
  const answer = await getRL().question(`  ${question} `);
  return answer.trim();
}

export async function askSecret(question: string): Promise<string> {
  const answer = await ask(question);
  return answer;
}

export async function askChoice(question: string, choices: string[]): Promise<string> {
  const prompt = `${question} [${choices.join(" / ")}]:`;
  while (true) {
    const answer = (await ask(prompt)).toLowerCase();
    const match = choices.find((c) => c.toLowerCase() === answer || c.toLowerCase().startsWith(answer));
    if (match) return match;
    console.log(`  Please choose one of: ${choices.join(", ")}`);
  }
}

export async function askYesNo(question: string, defaultValue = false): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${hint}:`)).toLowerCase();
  if (!answer) return defaultValue;
  return answer.startsWith("y");
}
