# Product Sense

## Who the user is
A Sangfor field engineer (or the pre-sales/delivery/ops team around them). Their day is discovery, design, PoC, delivery, and operations across HCI/IAG/Endpoint Secure/Cyber Command — plus firefighting and the paperwork nobody has time for. Their scarcest resources are **memory of version deltas** and **discipline under time pressure**. That is exactly where the product wins.

## The mental model to hold
The product is not "an assistant that answers questions." It is **a trusted colleague who prepares the work so a human can sign it off in minutes**. Every output should be usable as-is by a real engineer in front of a real customer: cited, risk-classified, checklist-complete, and honest about gaps.

## What earns trust (and what destroys it)
- **Earns trust:** a citation on every claim; a surfaced "I can't determine this from what I captured"; a dry-run preview before any change; a rollback plan attached to every apply.
- **Destroys trust instantly:** one fabricated value, one INDETERMINATE dressed up as PASS, one change that "looked like a 2xx" but didn't happen. A single false confidence event costs more than a hundred "I don't know"s. This is why the codebase treats false-PASS prevention as a hard invariant, not a quality nice-to-have.

## Prioritization framework
1. **Safety/correctness before capability.** A new automation ships only after its gates and read-back verification exist. Breadth without the safety spine is negative value.
2. **Read-only depth before write breadth.** L3 advisory/diagnosis across products beats shallow write automation, because advisory is where the trust (and most of the time savings) lives.
3. **Honest measurement over impressive demos.** The replacement-rate metric (`@sangfor/competency`) counts a capability only when it's `auto_allowed` **and** `field_verified` **and** tool-covered **and** evidence-backed — so the roadmap is driven by what's *proven*, not what *demos*.
4. **Local-first, human-in-the-loop.** Prefer the option that keeps customer data local and keeps a human on the irreversible decision.

## The permanent line
The AI advises, prepares, previews, and verifies. The human owns the irreversible hand and the signature. Features that would cross that line (autonomous irreversible change, unattended production writes, autonomous rollback) are out of scope by design, not by current limitation — see [product-specs/field-engineer-replacement.md](product-specs/field-engineer-replacement.md).

## How to make a product call here
Ask, in order: *Is it safe by default? Is every output cited and honest about uncertainty? Does it keep the human on the irreversible decision? Does it move a proven, field-verified capability forward?* If any answer is no, the feature is not ready — fix that before shipping.
