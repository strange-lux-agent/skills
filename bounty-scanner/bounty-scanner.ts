#!/usr/bin/env bun
/**
 * Bounty Scanner skill CLI
 * Autonomous bounty hunting — scan, match, claim, and track bounties
 *
 * Usage: bun run bounty-scanner/bounty-scanner.ts <subcommand> [options]
 */

import { Command } from "commander";
import { printJson, handleError } from "../src/lib/utils/cli.js";
import { getWalletManager } from "../src/lib/services/wallet-manager.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const BOUNTY_API = "https://1btc-news-api.p-d07.workers.dev";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchBounties(): Promise<any[]> {
  const res = await fetch(`${BOUNTY_API}/bounties`);
  if (!res.ok) throw new Error(`Bounty API returned ${res.status}`);
  const data = await res.json();
  return (data as any).bounties ?? [];
}

function getStxAddress(address?: string): string {
  if (address) return address;
  const walletManager = getWalletManager();
  const session = walletManager.getSessionInfo();
  if (session?.stxAddress) return session.stxAddress;
  throw new Error(
    "No STX address provided and wallet is not unlocked. " +
      "Either provide --address or unlock your wallet first."
  );
}

/**
 * Load installed skill names and descriptions from local SKILL.md files.
 */
function getInstalledSkills(): Array<{ name: string; description: string; tags: string[] }> {
  const skills: Array<{ name: string; description: string; tags: string[] }> = [];
  const repoRoot = join(import.meta.dir, "..");

  // Read skills.json if it exists
  const manifestPath = join(repoRoot, "skills.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      for (const skill of manifest.skills ?? []) {
        skills.push({
          name: skill.name ?? "",
          description: skill.description ?? "",
          tags: skill.tags ?? [],
        });
      }
      return skills;
    } catch {
      // fall through to directory scan
    }
  }

  return skills;
}

/**
 * Score how well a bounty matches the agent's installed skills.
 * Returns 0-1 confidence score.
 */
function scoreBountyMatch(
  bounty: { title: string; description: string },
  skills: Array<{ name: string; description: string; tags: string[] }>
): { score: number; matchedSkills: string[]; reason: string } {
  const bountyText = `${bounty.title} ${bounty.description}`.toLowerCase();
  const matchedSkills: string[] = [];
  let score = 0;

  // Keyword matching against skill names and descriptions
  for (const skill of skills) {
    const skillWords = `${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    const skillTokens = skillWords.split(/[\s\-_,./]+/).filter((t) => t.length > 2);

    let hits = 0;
    for (const token of skillTokens) {
      if (bountyText.includes(token)) hits++;
    }

    if (hits >= 2) {
      matchedSkills.push(skill.name);
      score += Math.min(hits * 0.15, 0.5);
    }
  }

  // Bonus for having wallet/signing (most bounties need them)
  const hasWallet = skills.some((s) => s.name === "wallet");
  const hasSigning = skills.some((s) => s.name === "signing");
  if (hasWallet) score += 0.1;
  if (hasSigning) score += 0.1;

  // Cap at 1.0
  score = Math.min(score, 1.0);

  const reason =
    matchedSkills.length > 0
      ? `Matches skills: ${matchedSkills.join(", ")}`
      : "No direct skill match — may require new capabilities";

  return { score: Math.round(score * 100) / 100, matchedSkills, reason };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command()
  .name("bounty-scanner")
  .description("Autonomous bounty hunting — scan, match, claim, and track bounties");

// -- scan -------------------------------------------------------------------
program
  .command("scan")
  .description("List all open bounties with rewards")
  .action(async () => {
    try {
      const bounties = await fetchBounties();
      const open = bounties
        .filter((b: any) => b.status === "open")
        .map((b: any) => ({
          id: b.id,
          title: b.title,
          reward: b.reward,
          posted: b.created_at,
        }));

      printJson({
        success: true,
        openBounties: open.length,
        bounties: open,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- match ------------------------------------------------------------------
program
  .command("match")
  .description("Match open bounties to your installed skills")
  .action(async () => {
    try {
      const bounties = await fetchBounties();
      const skills = getInstalledSkills();
      const open = bounties.filter((b: any) => b.status === "open");

      const matches = open
        .map((b: any) => {
          const match = scoreBountyMatch(
            { title: b.title, description: b.description ?? "" },
            skills
          );
          return {
            id: b.id,
            title: b.title,
            reward: b.reward,
            confidence: match.score,
            matchedSkills: match.matchedSkills,
            reason: match.reason,
          };
        })
        .sort((a, b) => b.confidence - a.confidence);

      const recommended = matches.filter((m) => m.confidence >= 0.3);

      printJson({
        success: true,
        installedSkills: skills.length,
        openBounties: open.length,
        recommendedBounties: recommended.length,
        matches: matches.slice(0, 10),
        action:
          recommended.length > 0
            ? `Top match: "${recommended[0].title}" (${recommended[0].confidence * 100}% confidence, ${recommended[0].reward} sats)`
            : "No strong matches found. Install more skills or check back later.",
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- claim ------------------------------------------------------------------
program
  .command("claim")
  .argument("<bounty-id>", "Bounty ID to claim")
  .description("Claim a bounty for your agent")
  .action(async (bountyId: string) => {
    try {
      const stxAddress = getStxAddress();

      const res = await fetch(`${BOUNTY_API}/bounties/${bountyId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimer: stxAddress }),
      });

      const data = await res.json();

      if (!res.ok) {
        printJson({
          success: false,
          error: (data as any).error ?? `HTTP ${res.status}`,
          bountyId,
        });
        return;
      }

      printJson({
        success: true,
        bountyId,
        claimer: stxAddress,
        message: "Bounty claimed. Start building and submit your PR.",
        ...(data as object),
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- status -----------------------------------------------------------------
program
  .command("status")
  .description("Bounty board health — open, claimed, completed counts")
  .action(async () => {
    try {
      const bounties = await fetchBounties();

      const stats = {
        total: bounties.length,
        open: bounties.filter((b: any) => b.status === "open").length,
        claimed: bounties.filter((b: any) => b.status === "claimed").length,
        completed: bounties.filter((b: any) => b.status === "completed").length,
        cancelled: bounties.filter((b: any) => b.status === "cancelled").length,
        totalRewardsOpen: bounties
          .filter((b: any) => b.status === "open")
          .reduce((sum: number, b: any) => sum + (b.reward ?? 0), 0),
      };

      printJson({
        success: true,
        ...stats,
        summary: `${stats.open} open bounties worth ${stats.totalRewardsOpen.toLocaleString()} sats`,
      });
    } catch (err) {
      handleError(err);
    }
  });

// -- my-claims --------------------------------------------------------------
program
  .command("my-claims")
  .description("List bounties you have claimed or completed")
  .option("--address <stx>", "Your STX address")
  .action(async (opts: { address?: string }) => {
    try {
      const stxAddress = getStxAddress(opts.address);
      const bounties = await fetchBounties();

      const mine = bounties.filter(
        (b: any) =>
          b.claimer === stxAddress ||
          b.poster === stxAddress
      );

      printJson({
        success: true,
        agent: stxAddress,
        claimed: mine.filter((b: any) => b.claimer === stxAddress).length,
        posted: mine.filter((b: any) => b.poster === stxAddress).length,
        bounties: mine.map((b: any) => ({
          id: b.id,
          title: b.title,
          status: b.status,
          reward: b.reward,
          role: b.claimer === stxAddress ? "claimer" : "poster",
        })),
      });
    } catch (err) {
      handleError(err);
    }
  });

program.parse();
