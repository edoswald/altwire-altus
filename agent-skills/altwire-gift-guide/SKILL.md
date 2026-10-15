---
name: altwire-gift-guide
description: Plan, research, and draft AltWire holiday gift guides and seasonal roundups (gear, plugins, albums, vinyl, accessories). Use when asked for a gift guide, a "best of" or year-end list, holiday content ideas, or a holiday content calendar for AltWire.
---

# AltWire gift guides and holiday content

AltWire (altwire.net) is an independent music publication: rock, alternative, emerging artists, live music, and music gear and plugins. Its gift guides should only recommend things AltWire has actually covered or can stand behind. They are not generic shopping lists.

## Workflow

1. **Look at last season first.** Call `get_altwire_seasonal_comparison` with the defaults (last November–December). Note:
   - `seasonal_queries`: the gift and holiday searches that already find AltWire, and where it ranks.
   - `refresh_candidates`: last year's seasonal articles that earned traffic. Updating one of these usually beats starting a new URL. Recommend refresh vs. new for each guide.
   - `last_28d_position` against `season_position`: whether a page has slipped since then.
2. **Pull candidates from AltWire's own reviews.** Call `find_gift_guide_candidates` once per guide theme, for example:
   - Home studio: `product_types: ["recording"]`, `min_overall: 8`
   - Plugins and software: `product_types: ["software"]`, `min_overall: 8`
   - Budget picks: `min_rating_subcategory: "Value"`, `min_rating_value: 8`
   - Albums or vinyl for the music fan: `product_types: ["album"]`, `published_after` set to January 1 of this year
   - Prefer reviews from the last 18 months. Older gear may be discontinued or replaced; check before including it.
3. **Check every pick on the web.** The scores have no prices, and products go out of stock or get new versions. For each pick, confirm it is still sold, its current price (note the date checked), and whether there is a newer model. Drop anything you can't confirm.
4. **Fill gaps.** If a theme has fewer than 5 solid picks from AltWire reviews, say so. Suggest what to add (an item AltWire covered in news, or a quick hands-on), but don't invent an endorsement. Use `search_altwire_archive` to find other AltWire coverage of a product or artist.
5. **Draft** in the structure below, then list what still needs a human: prices to re-check, photos, affiliate links, disclosure confirmation.

## Guide structure

- **Headline.** Specific and searchable: who it's for plus the year, e.g. "Gifts for Home Recording Musicians 2026". Match the wording of the best-performing `seasonal_queries` where it fits naturally.
- **Intro.** 2–3 sentences: who the guide is for and how the picks were chosen (from AltWire's reviews and hands-on time).
- **Price brackets.** Group picks under: Under $50, $50–$150, $150–$500, $500 and up. Skip empty brackets.
- **Each pick:**
  - Product name as the subhead.
  - One or two sentences on why it is a good gift, drawn from the review's pros, in AltWire's words.
  - One honest caveat from the cons.
  - "Price at time of writing: $X (checked <date>)".
  - A link to AltWire's full review.
- **Closing line** pointing to related AltWire guides or reviews.
- Aim for 8–15 picks per guide. A focused short guide beats a padded long one.

## Voice

Direct, knowledgeable, conversational, for music-literate readers who follow indie and alternative scenes.
- No filler and no hollow superlatives ("must-have", "game-changer", "the perfect gift for everyone").
- Lead with the most interesting thing.
- Active voice. Concrete details over vague praise.

## Disclosure

- If any pick was a review unit or a complimentary copy, the guide needs a disclosure near the top. Use AltWire's existing review disclosure wording if the review text has one; otherwise flag it for Derek.
- If the guide will carry affiliate links, say so in the intro. Ask Derek whether a guide uses affiliate links before drafting that line; never assume it.

## Holiday calendar (2026)

| Date | Moment |
|---|---|
| Early–mid November | Guides should be published and indexed. Search interest for gift queries ramps through November. |
| Thu Nov 26 | Thanksgiving (US) |
| Fri Nov 27 | Black Friday |
| Mon Nov 30 | Cyber Monday |
| Fri Dec 4 (evening) | Hanukkah begins |
| Mid-December | Shipping cutoffs: check retailers; add a "last-minute / digital gifts" angle (plugins, subscriptions, gift cards) |
| Fri Dec 25 | Christmas |
| Late December | Year-end "best of" lists; check last season's `seasonal_queries` for which best-of searches find AltWire |

When asked for a holiday content calendar, work back from these dates. Each guide needs time to draft, re-check prices, and get indexed before its peak.

## Output

- **In Slack:** a short summary with the plan or draft outline. Put long drafts and trackers in files: a `.docx` for a guide draft, an `.xlsx` for a pick tracker with columns Guide, Product, AltWire review URL, Overall, Price, Price checked, In stock, Notes.
- **Images:** suggest one hero image idea per guide. If Derek has Canva linked (in DMs), offer to start the graphic there.
