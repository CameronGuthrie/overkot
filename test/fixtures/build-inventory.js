// Synthetic equipped gear, with a different first preset and non-default configs.
const id = number => ({ $oid: number.toString(16).padStart(24, '0') });
const { getCollectionCatalog } = require('../../src/modules/collectionCatalog');
function buildInventory() {
  const catalogue = getCollectionCatalog();
  const rune = '/SF/Upgrades/Runes/Weapon/GreatSword/StarterRune';
  const weapon = '/SF/Weapons/Melee/OneHand/DendritSwordAndBoard/DendritSwordAndBoardMeleeWeapon';
  return {
    AccountId: 'private-account', Nonce: 'private-session', PlayerLevel: 18,
    CurrentLoadOutIds: [id(2), id(3), id(4)],
    LoadOutPresets: { NORMAL: [
      { ItemId: id(1), n: 'Not equipped', m: { ItemId: id(99) } },
      { ItemId: id(2), n: 'Héros 🌿', vu: .25, vv: .25, m: { ItemId: id(10), cus: 1 },
        l: { ItemId: id(11), cus: 0 }, s: { ItemId: id(12), cus: 1 } },
    ], NORMAL_PVP: [{ ItemId: id(3) }], SENTINEL: [{ ItemId: id(4) }] },
    Melee: [{ ItemId: id(10), ItemType: weapon, XP: 225000, Quality: 'IQ_NOBLE',
      UpgradeType: '/SF/Types/Items/Kintsugi/Weapons/KintsugiUpgradeMeleeR',
      AspectFingerprint: JSON.stringify({ buffs: [{ Tag: 'BlockingLessStaggerMod' }, { Tag: 'BlockingLessStaggerMod' }], curses: [{ Tag: 'AttackSpeedMod' }] }),
      Configs: [{ Upgrades: ['/SF/Upgrades/WrongRune'] }, { Upgrades: [id(20), id(21), id(22), id(23), id(24)] }],
    }],
    LongGuns: [{ ItemId: id(11), ItemType: '/SF/Weapons/Ranged/TwoHand/SinecureBow/SinecureBowRangedMeleeWeapon', XP: 225001, Quality: 'IQ_WORN', Configs: [{}] }],
    Pistols: [],
    Suits: [{ ItemId: id(12), ItemType: '/SF/Souls/Bromius/BromiusSoul', Configs: [{ Skins: [] }, { Skins: [
      id(30), '/SF/Upgrades/Skins/Body/BromiusBody', '/SF/Upgrades/Skins/Legs/BromiusLegs', '/SF/Upgrades/Skins/Totem/Talisman',
    ] }] }],
    WeaponSkins: [{ ItemId: id(30), ItemType: '/SF/Upgrades/Skins/Helmets/BromiusHelmet' }],
    Upgrades: [{ ItemId: id(20), ItemType: rune, UpgradeFingerprint: '{"lvl":3}' }, ...[21, 22, 23, 24].map((number, index) => ({
      ItemId: id(number), ItemType: `/SF/Upgrades/Totems/Test${number}`, UpgradeFingerprint: {
        lvl: index, pol: ['AP_COURAGE', 'AP_GRACE', 'AP_SPIRIT', 'AP_SPIRIT'][index], compat: ['/SF/Upgrades/Techniques/SwordSkillTree'],
      },
    }))],
    RawUpgrades: [{ ItemType: '/SF/Upgrades/Totems/Unequipped', UpgradeFingerprint: '{"lvl":3}' }],
    // 243,000 equipment mastery + 33 completed 5,000-mastery discoveries
    // calculates ER 18. PlayerLevel above is deliberately not its authority.
    XPInfo: catalogue.mastery.items.map(item => ({ ItemType: item.itemType, XP: item.xpForMaxRank })),
    LoreFragmentScans: catalogue.discoveries.filter(item => item.masteryEligible).slice(0, 33)
      .map(item => ({ ItemType: item.itemType, Progress: item.required })),
    PlayerSkills: [],
    BonusAttributes: [{ key: 'OrengallQuest', value: 'AT_SPIRIT' }, { key: 'BromiusQuest', value: 'AT_COURAGE' }],
    SkillTrees: [{ ItemType: '/SF/Upgrades/Techniques/SwordSkillTree', Skills: [
      { ItemType: '/SF/Upgrades/Techniques/Sword/ParrySkill', Level: 0 },
      { ItemType: '/SF/Upgrades/Techniques/Sword/CritChanceSkill', Level: 2 },
    ] }],
  };
}
module.exports = { buildInventory, id };
