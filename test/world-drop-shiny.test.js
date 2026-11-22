'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../.build/world-drop-shiny-tests');

const harness = `using System;
using System.Collections.Generic;
using System.Reflection;
internal static class ShinyChecks {
 static void Require(bool value,string message) {if(!value)throw new Exception(message);}
 sealed class Fixture {
  public const long Base=0x140000000L,Region=0x500000,Pickup=0x510000,Store=0x520000,Item=0x530000,Type=0x540000;
  public readonly Dictionary<long,byte> Memory=new Dictionary<long,byte>();
  public readonly WorldDropShiny Profile;
  public bool Mutate, Fail;
  public Fixture() {
   var constructor=typeof(WorldDropShiny).GetConstructors(BindingFlags.Instance|BindingFlags.NonPublic)[0];
   Profile=(WorldDropShiny)constructor.Invoke(new object[]{Base,0x100000,Base+0x10000,Base+0x11000,
    Base+0x12000,Base+0x13000,Base+0x14000,Base+0x15000,Base+0x16000,Base+0x17000,Base+0x18000,Base+0x19000,Base+0x1a000});
   P(Region,Base+0x10000);P(Pickup,Base+0x11000);P(Base+0x10000+0x3e8,Base+0x13000);
   P(Store+0x28,Type);P(Item+8,Type);P(Item,Base+0x20000);P(Base+0x20000+0x290,Base+0x17000);P(Item+0x1cf8,0);
   P(Base+0x20000+0x200,Base+0x21000);B(Base+0x21000,0x0f,0xb6,0x81,0xb9,4,0,0,0xc3);B(Item+0x51e,0);B(Item+0x4b9,5);
   P(Region+0x230,0x600000);U(Region+0x238,8);P(0x600000,0x610000);P(0x610000,0x620000);
   B(0x620000+0x20,0);B(0x620000+0x288,1);P(0x620000,Base+0x22000);
   P(Base+0x22000+0xb0,Base+0x23000);B(Base+0x23000,0x0f,0xb6,0x81,0x88,2,0,0,0xc3);P(Base+0x22000+0x100,Base+0x14000);
   P(Region+0x240,0x630000);P(0x630000,0x640000);P(0x640000,Base+0x24000);P(Base+0x24000+0x760,Base+0x12000);
   P(Base+0x19000,0x650000);P(0x650000,0x660000);P(0x660000,Base+0x25000);
   P(Base+0x25000+0x148,Base+0x26000);B(Base+0x26000,0x83,0xb9,0x68,1,0,0,4,0x0f,0x94,0xc0,0xc3);
   U(0x660000+0x168,4);P(Base+0x25000+0xb8,Base+0x16000);P(0x660000+0x230,0x670000);U(0x660000+0x238,8);
   P(0x670000,0x680000);P(0x680000,0x690000);P(0x690000,Base+0x27000);
   P(Base+0x27000+0x18,Base+0x28000);B(Base+0x28000,0x48,0x8b,0x81,0xe8,1,0,0,0xc3);P(0x690000+0x1e8,0);
   P(Base+0x27000+0x90,Base+0x15000);P(Base+0x27000+0x378,Base+0x29000);B(Base+0x29000,0x48,0x8b,0x81,0x10,2,0,0,0x48,0x8b,0,0xc3);
   P(0x690000+0x210,0x6a0000);P(0x6a0000,0x6b0000);P(0x6b0000,Base+0x2a000);P(Base+0x2a000+0x2a8,Base+0x2b000);
   B(Base+0x2b000,0x48,0x8d,0x81,0x90,0xa9,0,0,0xc3);P(0x6b0000+0xa990,0);P(0x640000+0x7f8,0);
   byte[] first=new byte[16],second=new byte[16];var text=System.Text.Encoding.ASCII.GetBytes("0x000000");Array.Copy(text,first,text.Length);first[15]=7;second[15]=15;
   B(0x690000+0x128,first);B(0x690000+0x148,second);U(Pickup+0x988,1);B(Pickup+0x98c,0);
  }
  public void B(long at,params byte[] bytes){for(int i=0;i<bytes.Length;i++)Memory[at+i]=bytes[i];}
  public void P(long at,long value){B(at,BitConverter.GetBytes(value));}
  public void U(long at,uint value){B(at,BitConverter.GetBytes(value));}
  public bool Read(long at,byte[] bytes,int length){
   if(Fail)return false;
   for(int i=0;i<length;i++){byte value;if(!Memory.TryGetValue(at+i,out value))return false;bytes[i]=value;}
   if(Mutate&&at==Pickup+0x988)U(Pickup+0x988,BitConverter.ToUInt32(bytes,0)+1);
   return true;
  }
  public bool Run(out bool shiny){return Profile.TryRead(Read,Region,Pickup,Store,key=>key==Type?Item:0,out shiny);}
 }
 static void Main(){
  bool shiny;WorldDropShiny profile;
  foreach(byte[] image in new byte[][]{null,new byte[0],new byte[4096],new byte[8192]})
   Require(!WorldDropShiny.TryCreate(image,0x140000000L,0x140000100L,0x140000200L,out profile)&&profile==null,"malformed optional profile");
  var empty=new byte[8192];Require(!WorldDropShiny.TryCreate(empty,long.MaxValue,1,2,out profile),"overflow optional profile");
  var fixture=new Fixture();Require(fixture.Run(out shiny),"complete synthetic observation");
  Require(shiny==WorldDropShiny.Replay(1,0,0,ulong.MaxValue),"same seed pipeline");
  uint yes=0;while(yes<100000&&!WorldDropShiny.Replay(yes,0,0,ulong.MaxValue))yes++;
  Require(yes<100000,"positive synthetic shiny seed");fixture.U(Fixture.Pickup+0x988,yes);Require(fixture.Run(out shiny)&&shiny,"verified shiny true");
  uint no=0;while(no<100000&&WorldDropShiny.Replay(no,0,0,ulong.MaxValue))no++;
  fixture.U(Fixture.Pickup+0x988,no);Require(fixture.Run(out shiny)&&!shiny,"verified shiny false");
  fixture.B(Fixture.Item+0x51e,1);fixture.U(Fixture.Pickup+0x988,yes);Require(fixture.Run(out shiny)&&!shiny,"explicit native ignore-bin gate");
  fixture=new Fixture();fixture.B(Fixture.Item+0x4b9,2);Require(fixture.Run(out shiny)&&!shiny,"explicit native category gate");
  fixture=new Fixture();fixture.B(Fixture.Item+0x51e,2);Require(!fixture.Run(out shiny),"malformed eligibility unknown");
  fixture=new Fixture();fixture.P(Fixture.Item+8,0);Require(!fixture.Run(out shiny),"canonical resource identity unknown");
  fixture=new Fixture();fixture.P(Fixture.Item+0x1cf8,0x700000);Require(!fixture.Run(out shiny),"missing aspect metadata unknown");
  fixture=new Fixture();fixture.P(0x640000+0x7f8,1);Require(!fixture.Run(out shiny),"stale scene cache unknown");
  fixture=new Fixture();fixture.U(0x660000+0x168,3);Require(!fixture.Run(out shiny),"offline network branch unknown");
  fixture=new Fixture();fixture.B(Fixture.Base+0x23000,0xcc);Require(!fixture.Run(out shiny),"changed metadata getter unknown");
  fixture=new Fixture();fixture.Mutate=true;Require(!fixture.Run(out shiny),"racing pickup seed unknown");
  fixture=new Fixture();fixture.Fail=true;Require(!fixture.Run(out shiny),"read failure unknown");
  Require(!fixture.Profile.TryRead(fixture.Read,Fixture.Region,Fixture.Pickup,Fixture.Store,key=>0,out shiny),"unresolved canonical cache unknown");
  Console.WriteLine("passed readonly replay and eligibility checks");
  for(uint seed=0;seed<32;seed++)Console.Write(WorldDropShiny.Replay(seed,7,0x123456,0x1020304050607080UL)?"1":"0");
 }
}`;

test('native shiny replay verifies complete metadata and leaves unsupported or racing observations unknown', { skip: process.platform !== 'win32' }, () => {
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'checks.cs'), executable = path.join(directory, 'checks.exe');
  fs.writeFileSync(source, harness);
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${executable}`,
    path.resolve(__dirname, '../native/world-drop-shiny.cs'), source], { windowsHide: true, stdio: 'pipe' });
  const result = execFileSync(executable, [], { windowsHide: true, encoding: 'utf8' });
  assert.match(result, /passed readonly replay and eligibility checks/);
  const mask = (1n << 64n) - 1n, step = value => (value * 0x5851f42d4c957f2dn + 0x14057b7ef767814fn) & mask;
  const expected = Array.from({ length: 32 }, (_, seed) => {
    let state = BigInt(seed); for (let i = 0; i < 7; i++) state = step(state);
    state = (state | (0x123456n << 32n)) ^ 0x1020304050607080n;
    state = step(step(state)); return ((state >> 38n) & 0xffffffn) <= 8388n ? '1' : '0';
  }).join('');
  assert.equal(result.trim().split(/\r?\n/).at(-1), expected);
});
