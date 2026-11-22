'use strict';

const id = value => ({ $oid: `wolf-fixture-${value}` });
function wolfInventory() {
  return {
    CurrentLoadOutIds: [id('loadout-2')],
    LoadOutPresets: { SENTINEL: [
      { ItemId: id('loadout-1'), s: { ItemId: id('pet-2') } },
      { ItemId: id('loadout-2'), s: { ItemId: id('pet-1') } },
    ] },
    KubrowPets: [
      { ItemId: id('pet-1'), Details: {
        Name: '/SF/Language/Quests/OrengallPupName1', Temperment: 'TEMPERMENT_CURIOUS',
        Bond: 3481, Energy: 95, Guard: 150, Speed: 1350, Stamina: 41, Search: 600, Support: 2062,
        GuardSkill: 0, SpeedSkill: 1, StaminaSkill: 0, SearchSkill: 0, SupportSkill: 1,
        NeedsRest: false, RestDate: { $date: { $numberLong: '1789781861000' } },
      } },
      { ItemId: id('pet-2'), Details: {
        Name: '/SF/Language/Quests/OrengallPupName2', Temperment: 'TEMPERMENT_LOYAL',
        Bond: 20, Energy: 12, Guard: 3900, Speed: 700, Stamina: 150, Search: 0, Support: 500,
        GuardSkill: 2, SpeedSkill: 0, NeedsRest: true, RestDate: { $date: '1789781861000' },
      } },
    ],
  };
}
function wolfCatalog(language = 'en') {
  const fields = language === 'fr'
    ? { Guard: 'Cran', Speed: 'Vitesse', Stamina: 'Endurance', Search: 'Curiosité', Support: 'Cœur', Energy: 'Énergie', Bond: 'Lien', Temperament: 'Tempérament' }
    : { Guard: 'Guts', Speed: 'Speed', Stamina: 'Endurance', Search: 'Curiosity', Support: 'Heart', Energy: 'Energy', Bond: 'Bond', Temperament: 'Temperament' };
  return { schema: 1, labels: {
    ...Object.fromEntries(Object.entries(fields).map(([field, label]) => [`/SF/Language/Pets/PetStat_${field}`, label])),
    '/SF/Language/Pets/PetTemperment_Curious': language === 'fr' ? 'Rusé' : 'Clever',
    '/SF/Language/Pets/PetTemperment_Loyal': language === 'fr' ? 'Loyal' : 'Loyal',
    '/SF/Language/Pets/PetRank1_Wild': language === 'fr' ? 'Sauvage' : 'Wild',
    '/SF/Language/Pets/PetRank2_Tame': language === 'fr' ? 'Apprivoisé' : 'Tame',
    '/SF/Language/Pets/PetRank3_Loyal': 'Loyal',
    '/SF/Language/Pets/PetRank4_Loving': language === 'fr' ? 'Aimant' : 'Loving',
    '/SF/Language/Pets/PetRank5_Soulbound': language === 'fr' ? 'Âmes liées' : 'Soulbound',
    '/SF/Language/Quests/OrengallPupName1': 'Ciar', '/SF/Language/Quests/OrengallPupName2': 'Cathal',
  }, progression: { maxEnergy: 150, maxMaturity: 15, skillThresholds: [600, 2000, 3900, 6300, 9000],
    bondThresholds: [125000, 421900, 1000000, 1953100], estimated: false, confirmedSkillLevels: 5 } };
}
module.exports = { wolfInventory, wolfCatalog, id };
