const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('native drop snapshots require owned live weapons, preserve opaque identity and reject stale or unsupported data', { skip: process.platform !== 'win32' }, () => {
  const root = path.resolve(__dirname, '..'), directory = path.join(root, '.build', 'world-drop-reader-tests');
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'drop-walk-check.cs'), executable = path.join(directory, 'drop-walk-check.exe');
  fs.writeFileSync(source, `using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
internal static class DropWalkChecks {
 static readonly List<IntPtr> blocks=new List<IntPtr>();
 static Type host=typeof(PlayerPositionReader),readerType=host.GetNestedType("Reader",BindingFlags.NonPublic);
 static long Allocate(int size) {IntPtr p=Marshal.AllocHGlobal(size);blocks.Add(p);Marshal.Copy(new byte[size],0,p,size);return p.ToInt64();}
 static void Ptr(long address,long value) {Marshal.WriteInt64(new IntPtr(address),value);}
 static void U32(long address,int value) {Marshal.WriteInt32(new IntPtr(address),value);}
 static void Field(object target,string name,object value) {target.GetType().GetField(name).SetValue(target,value);}
 static object Call(object reader,string name,params object[] args) {return readerType.GetMethod(name,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic).Invoke(reader,args);}
 static object Snapshot(object reader) {return readerType.GetField("DroppedItems").GetValue(reader);}
 static IList Items(object reader) {object snapshot=Snapshot(reader);return (IList)snapshot.GetType().GetField("Items").GetValue(snapshot);}
 static string Id(object reader) {return (string)Items(reader)[0].GetType().GetField("Id").GetValue(Items(reader)[0]);}
 static void Require(bool value,string message) {if(!value)throw new Exception(message);}
 static void Sample(object reader,long avatar) {Call(reader,"RefreshDungeonFrames");Call(reader,"ReadDungeonFrames",avatar);}
 static int Main() {
  object reader=null;
  try {
   // These structures are owned by this test process. The production reader
   // performs real RPM and VirtualQueryEx against them, never a game fixture.
   long module=Allocate(0x10000),avatar=Allocate(0x200),context=Allocate(0x100),region=Allocate(0x210);
   long regionHandle=Allocate(8),table=Allocate(16),entityHandle=Allocate(8),entity=Allocate(0x990);
   long entityType=Allocate(0x58),storeHandle=Allocate(8),store=Allocate(0x600),storeType=Allocate(0x58),weapon=Allocate(0x58);
   long atomTable=Allocate(0x100),directory=Allocate(512),leaf=Allocate(512),folder=Allocate(4);
   Ptr(avatar+0x1e0,context);Ptr(context,module+0x1300);Ptr(context+8,module+0x4300);Ptr(context+0x90,regionHandle);
   Ptr(regionHandle,region);Ptr(region,module+0x1400);Ptr(region+8,module+0x4400);
   Ptr(region+0x200,table);U32(region+0x208,8);Ptr(table,entityHandle);Ptr(entityHandle,entity);
   Ptr(entity,module+0x1200);Ptr(entity+8,entityType);Ptr(entityType+0x18,module+0x4200);Ptr(entity+0x1e0,context);
   // Real pickups may have scale. Only the verified world-position field is
   // needed; requiring the avatar's unit orientation would hide valid loot.
   Marshal.Copy(new float[]{1.3f,0,0,0,0,1.3f,0,0,0,0,1.3f,0,10,0,20,1},0,new IntPtr(entity+0xa0),16);
   Ptr(entity+0x960,storeHandle);Ptr(storeHandle,store);Ptr(store,module+0x1100);Ptr(store+8,storeType);Ptr(storeType+0x18,module+0x4100);
   Ptr(store+0x28,weapon);Ptr(weapon+0x18,module+0x4000);Ptr(weapon+0x10,folder);U32(folder,1);U32(weapon+0x2c,2);
   Ptr(module+0x3000,atomTable);Ptr(atomTable+16,directory);Ptr(atomTable+32,leaf);
   byte[] folderBytes=Encoding.ASCII.GetBytes("/SF/Weapons/Melee/Test/");Marshal.Copy(folderBytes,0,new IntPtr(directory),folderBytes.Length);
   byte[] leafBytes=Encoding.ASCII.GetBytes("TestWeapon");Marshal.Copy(leafBytes,0,new IntPtr(leaf),leafBytes.Length);
   using(Process process=Process.GetCurrentProcess()) {
    reader=Activator.CreateInstance(readerType,new object[]{process});
    readerType.GetField("ModuleBase").SetValue(reader,module);
    object profile=Activator.CreateInstance(host.GetNestedType("ImageProfile",BindingFlags.NonPublic));
    Field(profile,"Base",module);Field(profile,"Size",0x10000);Field(profile,"Code",0x2000);Field(profile,"CodeSize",0x1000);
    Field(profile,"Data",0x1000);Field(profile,"DataSize",0x1000);Field(profile,"Metadata",0x3000);Field(profile,"MetadataSize",0x2000);
    foreach(var pair in new[]{new[]{"ContextType","4300"},new[]{"ContextVtable","1300"},new[]{"RegionType","4400"},new[]{"RegionVtable","1400"},new[]{"LevelInfoType","4500"},new[]{"DropType","4200"},new[]{"DropVtable","1200"},new[]{"StoreItemType","4100"},new[]{"StoreItemVtable","1100"},new[]{"WeaponType","4000"},new[]{"AtomTable","3000"}})
     Field(profile,pair[0],module+Convert.ToInt32(pair[1],16));
    Field(profile,"DropsSupported",true);Field(profile,"StoreReferenceOffset",0x960);Field(profile,"StoreWeaponOffset",0x28);
    readerType.GetField("profile",BindingFlags.Instance|BindingFlags.NonPublic).SetValue(reader,profile);
    Sample(reader,avatar);Require(Items(reader).Count==1,"scaled nearby owned weapon is detected");string id=Id(reader);
    Require(id=="drop-1","identity is an opaque sequence, not a pointer");
    host.GetMethod("OutputWorldDrops",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new[]{Snapshot(reader)});
    Sample(reader,avatar);Require(Id(reader)==id,"unchanged live item keeps its identity");
    long resources=Allocate(32),weakOne=Allocate(8),weakTwo=Allocate(8),itemOne=Allocate(0x1d00),itemTwo=Allocate(0x1d00);
    Ptr(module+0x1500,module+0x2000);Ptr(itemOne,module+0x1500);Ptr(itemTwo,module+0x1500);Ptr(itemOne+8,weapon);Ptr(itemTwo+8,weapon);
    Ptr(weakOne,itemOne);Ptr(weakTwo,itemTwo);Ptr(resources,weakOne);Ptr(resources+8,weapon);Ptr(resources+16,weakTwo);Ptr(resources+24,weapon);
    Ptr(module+0x3180,resources);U32(module+0x3188,32);U32(module+0x318c,32);Field(profile,"ResourceManager",module+0x3100);
    Require((long)Call(reader,"ResolveLoadedResource",weapon)==itemOne,"exact typed resource handles resolve without heap scanning");
    Marshal.WriteByte(new IntPtr(itemTwo+0x51e),1);
    Require((long)Call(reader,"ResolveLoadedResource",weapon)==0,"conflicting live eligibility is unknown");
    Marshal.WriteByte(new IntPtr(itemTwo+0x51e),0);Ptr(weakOne,0);
    Require((long)Call(reader,"ResolveLoadedResource",weapon)==itemTwo,"expired weak handles cannot retain old metadata");
    U32(module+0x3188,32*1024*1024+16);
    Require((long)Call(reader,"ResolveLoadedResource",weapon)==0,"resource-owner vector has a strict byte bound");U32(module+0x3188,32);
    Marshal.WriteByte(new IntPtr(entity+0x20),1);U32(region+0x208,16);
    Call(reader,"ReadDungeonFrames",avatar);Require(Items(reader).Count==1,"particle-count churn preserves the bounded refresh cache between poses");
    Sample(reader,avatar);Require(Items(reader).Count==0,"destroyed item is removed on the next complete snapshot");
    Marshal.WriteByte(new IntPtr(entity+0x20),0);Sample(reader,avatar);Require(Items(reader).Count==1&&Id(reader)!=id,"reused address gets a new identity after removal");
    Ptr(entity+0x1e0,0);Sample(reader,avatar);Require(Items(reader).Count==0,"detached item is excluded");Ptr(entity+0x1e0,context);
    Ptr(storeType+0x18,0);Sample(reader,avatar);Require(Items(reader).Count==0,"incorrect store-item class is excluded");Ptr(storeType+0x18,module+0x4100);
    Ptr(weapon+0x18,0);Sample(reader,avatar);Require(Items(reader).Count==0,"nonweapon resource is excluded");Ptr(weapon+0x18,module+0x4000);
    Marshal.Copy(new float[]{81,0,0},0,new IntPtr(entity+0xd0),3);Sample(reader,avatar);Require(Items(reader).Count==0,"items beyond 80 world units are excluded");
    Marshal.Copy(new float[]{float.NaN,0,0},0,new IntPtr(entity+0xd0),3);Sample(reader,avatar);Require(Items(reader).Count==0,"nonfinite positions are excluded");
    Marshal.Copy(new float[]{10,0,20},0,new IntPtr(entity+0xd0),3);Field(profile,"DropsSupported",false);Sample(reader,avatar);
    Require(!(bool)Snapshot(reader).GetType().GetField("Available").GetValue(Snapshot(reader)),"optional unsupported profile reports unavailable");
    host.GetMethod("OutputWorldDrops",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new[]{Snapshot(reader)});
    Field(profile,"DropsSupported",true);Ptr(context+0x90,0);Sample(reader,avatar);Require(Items(reader).Count==0,"losing region ownership clears cached markers");
   }
   return 0;
  }catch(Exception error){Console.Error.WriteLine(error);return 1;}
  finally {if(reader!=null)((IDisposable)reader).Dispose();foreach(IntPtr p in blocks)Marshal.FreeHGlobal(p);}
 }
}`);
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:DropWalkChecks', `/out:${executable}`,
    path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), source], { stdio: 'pipe', windowsHide: true });
  const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  const snapshots = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(snapshots[0].items, [{ id: 'drop-1', itemType: '/SF/Weapons/Melee/Test/TestWeapon',
    position: { x: 10, y: 0, z: 20 }, shiny: null }]);
  assert.equal(snapshots[0].status, 'available'); assert.equal(snapshots[1].status, 'unavailable');
  assert.deepEqual(snapshots[1].items, []);
  assert.ok(result.stdout.split(/\r?\n/).every(line => Buffer.byteLength(line) < 32768));
});
