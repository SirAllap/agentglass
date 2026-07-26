# GPT-5.6 Sol API Pricing Research

**Accessed:** 2026-07-26
**Scope:** Direct OpenAI API text-token pricing for `gpt-5.6-sol`; all prices are USD per 1 million tokens.
**Sources:** First-party OpenAI documentation only.

## Recommended default

Use **Standard, short-context** pricing as the general-purpose default:

| Input | Cached input | Cache write | Output |
|---:|---:|---:|---:|
| $5.00 | $0.50 | $6.25 | $30.00 |

This is the least-assumptive default for ordinary synchronous API traffic. In agentglass terminology, OpenAI's "cached input" maps to `cache_read`, while "cache write" maps to `cache_write`. GPT-5.6 cache writes are billable at 1.25 times uncached input and are reported as `cache_write_tokens`; cache reads are reported as `cached_tokens`. [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

The legacy `gpt-5` model remains available at $1.25 input, $0.125 cached input, and $10 output per million tokens. It therefore needs a separate entry rather than sharing GPT-4.1's label and rates. [GPT-5 model page](https://developers.openai.com/api/docs/models/gpt-5)

## Alternate rates

| Processing mode | Context | Input | Cached input | Cache write | Output |
|---|---|---:|---:|---:|---:|
| Standard | Short (up to 272K input tokens) | $5.00 | $0.50 | $6.25 | $30.00 |
| Standard | Long (over 272K input tokens) | $10.00 | $1.00 | $12.50 | $45.00 |
| Batch | Short | $2.50 | $0.25 | $3.125 | $15.00 |
| Batch | Long | $5.00 | $0.50 | $6.25 | $22.50 |
| Flex | Short | $2.50 | $0.25 | $3.125 | $15.00 |
| Flex | Long | $5.00 | $0.50 | $6.25 | $22.50 |
| Priority | Short only | $10.00 | $1.00 | $12.50 | $60.00 |

For prompts over 272K input tokens, OpenAI applies the long-context multipliers to the **entire request**, not only tokens above the threshold: input-side rates double and output is 1.5 times the short-context rate. The model supports a 1,050,000-token context window. [GPT-5.6 Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol)

Batch and Flex are both half the Standard rates. Batch is asynchronous with a 24-hour completion window; Flex trades slower responses and possible resource unavailability for Batch-level pricing. Priority doubles the short-context Standard rates for lower and more consistent latency, and OpenAI states that long context is not supported on Priority. [Batch API](https://developers.openai.com/api/docs/guides/batch), [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing), and [Priority processing](https://developers.openai.com/api/docs/guides/priority-processing)

## Default-selection implications

- A single static price record cannot be exact across context lengths and service tiers. Standard short-context rates are the appropriate neutral default; use an override or tier-aware accounting when traffic is known to use Batch, Flex, Priority, or inputs over 272K tokens.
- Do not set cache writes to zero for GPT-5.6. Unlike earlier model families, eligible prompt prefixes written by GPT-5.6 are charged at 1.25 times uncached input.
- Priority can also be configured as a project default, so requests that omit `service_tier` are not guaranteed to be billed as Standard. The response object's `service_tier` identifies the tier actually used. [Priority processing](https://developers.openai.com/api/docs/guides/priority-processing)
- Eligible regional-processing endpoints add a 10% uplift for models released on or after 2026-03-05. Direct OpenAI pricing may also differ from OpenAI models billed through Amazon Bedrock. [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [data controls](https://developers.openai.com/api/docs/guides/your-data)

## Sources

- OpenAI API pricing: https://developers.openai.com/api/docs/pricing
- GPT-5.6 Sol model: https://developers.openai.com/api/docs/models/gpt-5.6-sol
- GPT-5 model: https://developers.openai.com/api/docs/models/gpt-5
- Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching
- Batch API: https://developers.openai.com/api/docs/guides/batch
- Flex processing: https://developers.openai.com/api/docs/guides/flex-processing
- Priority processing: https://developers.openai.com/api/docs/guides/priority-processing
- Data controls and regional processing: https://developers.openai.com/api/docs/guides/your-data

All sources accessed 2026-07-26.
