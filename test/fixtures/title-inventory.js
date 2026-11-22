'use strict';

function epithet(type, name, target, legacyName = null) {
  return { internalId: 'FlavourItems.' + type, itemType: '/SF/Types/Items/Titles/' + type,
    storeItem: '/SF/StoreItems/Types/Items/Titles/' + type, langKey: '/SF/Language/Titles/' + type, value: name,
    challenge: { name: type + 'Challenge', path: '/SF/Types/Challenges/Titles/' + type + 'Challenge',
      enabled: true, requiredCount: target, legacyName, langKey: '/SF/Language/Titles/' + type + '_Req',
      value: 'Progress |PROGRESS|/|REQUIRED|.', text: 'Complete ' + target + ' actions.' } };
}
function epithets() {
  const rows = [epithet('CogahTitle', 'Of The Sleeve', 10), epithet('AbilitySoulStealTitle', 'Soul-bibber', 100),
    epithet('CastingSkillTreeKillsTitle', 'Gandura', 500, 'CastingSkillTreeKillsTitleChallenge')];
  rows[2].challenge.name += 'Fix'; rows[2].challenge.path += 'Fix';
  return Object.fromEntries(rows.map(row => [row.internalId, row]));
}
function titleInventory() {
  return { ChallengeProgress: [{ Name: 'CogahTitleChallenge', Progress: 3 },
    { Name: 'AbilitySoulStealTitleChallenge', Progress: 1, Complete: true },
    { Name: 'CastingSkillTreeKillsTitleChallenge', Progress: 40 },
    { Name: 'CastingSkillTreeKillsTitleChallengeFix', Progress: 75 },
    { Name: 'UnrelatedQuestChallenge', Progress: 200 }], FlavourItems: [] };
}
module.exports = { epithet, epithets, titleInventory };
