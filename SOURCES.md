# Vyoma: sources, credits and AI use

Every real number and science claim in the game, and where it comes from.
Copy the "NASA data used" section straight into the Space Apps submission form.

## NASA data used

| In the game | Value / claim | Source |
|---|---|---|
| Oxygen per person (`balance.json`) | 0.82 kg/day | NASA Life Support Baseline Values and Assumptions Document (BVAD), Anderson et al. 2018, NASA/TP-2015-218570/REV2 |
| Water per person (`balance.json`) | 3.2 kg/day (drink 2.0 + food rehydration 0.5 + hygiene 0.4 + flush 0.25 + medical 0.05) | BVAD and NASA Human Integration Design Handbook (HIDH) |
| Food per person (`balance.json`) | about 1.83 kg/day including packaging | BVAD |
| Everyday surface radiation (`balance.json`) | 0.64 mSv/day | Hassler et al., "Mars' Surface Radiation Environment Measured with the Mars Science Laboratory's Curiosity Rover", *Science*, 2014 (RAD instrument, Gale Crater) |
| Career radiation limit (`balance.json`) | 600 mSv | NASA-STD-3001 Volume 1 (2022 update) |
| Ice Basin / Arcadia Planitia | shallow buried ice | NASA Subsurface Water Ice Mapping (SWIM) project |
| Iron Fields / Meridiani Planum | hematite "blueberries", evidence of past water | NASA Opportunity rover (MER-B) mission results |
| Sunny Plains / Elysium Planitia | flat equatorial plain; dust on solar panels ended InSight in Dec 2022 | NASA InSight mission pages |
| Lava Tube / Tharsis | possible cave openings on Arsia Mons; none explored up close | Mars Odyssey THEMIS cave-candidate observations (Cushing et al., 2007) |
| Crater Rim / Gale Crater | Curiosity has explored Mount Sharp since 2012 | NASA Curiosity (MSL) mission pages |
| Dust Flats / Hellas Planitia | over 7 km deep; air pressure almost double the nearby highlands; often linked to dust-storm genesis | ESA/DLR Mars Express HRSC release (2014); NASA Photojournal PIA03170 (2001 global dust storm) |
| Water Recycler note (`buildings.json`) | ISS reached 98% water recovery in 2023 | NASA ISS Environmental Control and Life Support System announcement (June 2023) |
| Dust storm event story (`events.json`) | 2018 planet-wide storm ended Opportunity; nuclear-powered Curiosity kept working | NASA Opportunity and Curiosity mission pages |
| Solar particle event story (`events.json`) | 2003 "Halloween" storms: ISS crew sheltered in Zvezda | NASA ISS reports, Oct–Nov 2003 |
| Equipment failure story (`events.json`) | 2004 Elektron oxygen generator failures; crew used oxygen candles | NASA ISS Expedition 9/10 reports |

Everything else (building costs, power numbers, event chances, mission length) is game balance and is marked that way in the data files.

## Software and fonts

| What | Licence |
|---|---|
| Phaser 3 (game engine) | MIT |
| Vite (build tool) | MIT |
| Atkinson Hyperlegible (font, via Google Fonts) | SIL Open Font License 1.1 |
| Saira Condensed (font, via Google Fonts) | SIL Open Font License 1.1 |

## AI use (fill this in honestly before submitting)

- **Tool:** Claude (Anthropic), used as a coding assistant and science fact-checker.
- **What the AI did:** <!-- e.g. wrote first drafts of code we then reviewed and applied by hand; checked numbers against NASA sources -->
- **What the team did:** <!-- game design, sector choices, every balance decision, art, playtesting with kids, applying and testing every change -->
- **Example prompts:** <!-- paste 3-5 real prompts from the prompt log -->
- **Why:** <!-- e.g. a small team on a short deadline; the AI made it possible to fact-check every number against NASA documents -->
- **Art:** <!-- say whether commander portraits / sprites are hand-made or AI-generated -->
