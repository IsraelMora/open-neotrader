---
name: Example Decision Plugin
description: Reference implementation showing how to author a [decision] manifest section. Teaches the LLM the mechanical tool_call emission format using only the tool schema provided by the kernel.
---

# Example Decision Plugin

This plugin demonstrates the `[decision]` manifest capability introduced in F2 Slice 1.

## What it does

When activated, this plugin supplies a **decision prompt** to the kernel. The kernel reads the
prompt verbatim and prepends it to the LLM system prompt before each cycle, alongside the
compact tool schema built from all active plugins' `tools.json`.

## What it does NOT do

- It does not contain trading logic, sizing rules, risk thresholds, or symbol filters.
- It does not author any policy — it only teaches the LLM the mechanical call format.

## How to use as a starting point

1. Copy this directory to `plugins/your-decision-plugin/`.
2. Update `manifest.toml`: change `id`, `name`, `description`, and `version`.
3. Replace the `[decision]` prompt with your actual decision logic.
   - You can use `prompt = "..."` for short prompts (inline in manifest.toml).
   - For longer prompts, use `prompt_file = "DECISION.md"` and create that file.
4. Activate your plugin via the API (`POST /plugins/your-decision-plugin/activate`).
5. Deactivate this example plugin first — only ONE active `[decision]` plugin is allowed.

## Kernel neutrality contract

The kernel reads your prompt verbatim and never interprets it for trading meaning. All trading
policy lives in the plugin, not the kernel.
