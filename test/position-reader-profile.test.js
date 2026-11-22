const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const directory = path.join(root, '.build', 'position-profile-tests');
const executable = path.join(directory, 'profile-check.exe');

// Build small loaded-image fixtures: no installed or running game is needed.
// Every address is generated independently of the previously supported build.
const harness = `using System;
using System.Reflection;
using System.Text;
internal static class ProfileChecks {
 static Type Type = typeof(PlayerPositionReader).GetNestedType("ImageProfile", BindingFlags.NonPublic);
 static MethodInfo Headers = Type.GetMethod("Headers", BindingFlags.Public | BindingFlags.Static);
 static void Put(byte[] bytes, int at, params byte[] value) { Array.Copy(value, 0, bytes, at, value.Length); }
 static void U16(byte[] bytes, int at, ushort value) { Put(bytes, at, BitConverter.GetBytes(value)); }
 static void I32(byte[] bytes, int at, int value) { Put(bytes, at, BitConverter.GetBytes(value)); }
 static void I64(byte[] bytes, int at, long value) { Put(bytes, at, BitConverter.GetBytes(value)); }
 static object Header(byte[] bytes, long address, int size) { return Headers.Invoke(null, new object[]{bytes,address,size}); }
 static bool Resolve(object value) { return (bool)Type.GetMethod("Resolve").Invoke(value, null); }
 static long Field(object value,string name) { return (long)Type.GetField(name).GetValue(value); }
 static void Require(bool value,string message) { if (!value) throw new Exception(message); }
 sealed class Image {
  public byte[] HeaderBytes, Bytes;
  public long Base;
  public int Code, Data, Metadata, Size = 0x10000;
  public int[] Records = new int[5], Registrations = new int[5], Factories = new int[5], Vtables = new int[5];
  public int[] Getters = new int[6];
  public object Profile;
  public static readonly string[] Names = {"HumanPlayer","SFHumanPlayer","ContextImpl","RegionMgrImpl","LevelInfo"};
  public Image(int seed) {
   Base = seed % 2 == 0 ? 0x140000000L : 0x7ff712340000L;
   Code = seed % 2 == 0 ? 0x1000 : 0xa000;
   Data = seed % 2 == 0 ? 0x7000 : 0x1000;
   Metadata = seed % 2 == 0 ? 0xb000 : 0x5000;
   HeaderBytes = new byte[4096];
   U16(HeaderBytes,0,0x5a4d);I32(HeaderBytes,0x3c,0x80);I32(HeaderBytes,0x80,0x4550);
   U16(HeaderBytes,0x84,0x8664);U16(HeaderBytes,0x86,3);U16(HeaderBytes,0x94,240);U16(HeaderBytes,0x98,0x20b);I32(HeaderBytes,0xd0,Size);
   Section(0,".text",Code,0x5000,0x60000000);Section(1,".rdata",Data,0x4000,0x40000000);Section(2,".data",Metadata,0x3000,0xc0000000);
   Profile = Header(HeaderBytes,Base,Size);Require(Profile != null,"fixture headers");
   Bytes = (byte[])Type.GetField("Bytes").GetValue(Profile);
   for(int i=0;i<5;i++) {
    // Permute individual records, functions and vtables as well as sections.
    Records[i]=Metadata+0x200+((i+seed)%5)*0x100;
    Registrations[i]=Code+0x100+((i+2*seed)%5)*0x100;
    Factories[i]=Code+0x1000+((i+3*seed)%5)*0x100;
    Vtables[i]=Data+0x400+((i+4*seed)%5)*0x400;
   }
   for(int i=0;i<6;i++) Getters[i]=Code+0x4000+((i+seed)%6)*0x100;
   Put(Bytes,Getters[0],0x48,0x8b,0x81,0x48,0x01,0x00,0x00,0x48,0x8b,0x00,0xc3);
   Put(Bytes,Getters[1],0x48,0x8b,0x81,0xd0,0x00,0x00,0x00,0x48,0x8b,0x00,0x48,0x85,0xc0,0x75,0x02,0xcd,0x2c,0xc3);
   Put(Bytes,Getters[2],0x48,0x8d,0x41,0x70,0xc3);
   Put(Bytes,Getters[3],0x8b,0x81,0x08,0x02,0x00,0x00,0x48,0xc1,0xe8,0x03,0xc3);
   Put(Bytes,Getters[4],0x48,0x8d,0x81,0xd0,0x00,0x00,0x00,0xc3);
   Bytes[Getters[4]-1]=0xcc;Bytes[Getters[5]-1]=0xcc;
   Put(Bytes,Getters[5],0x48,0x8d,0x81,0xa0,0x00,0x00,0x00,0xc3);
   Bytes[Code+0x4800]=0xc3;Bytes[Code+0x4900]=0xc3;Bytes[Code+0x4a00]=0xc3;
   I64(Bytes,Data+0x3000,Base+Code+0x4800);
   for(int i=0;i<5;i++) {
    int parent=i==1?Records[0]:Metadata+0x1800+i*0x100;
    I64(Bytes,Records[i],Base+Data+0x3000);I64(Bytes,Records[i]+0x18,Base+parent);
    I64(Bytes,parent,Base+Data+0x3000);
    for(int slot=0;slot<12;slot++)I64(Bytes,Vtables[i]+slot*8,Base+Code+0x4800);
    byte[] name=Encoding.ASCII.GetBytes(Names[i]+"\\0");Put(Bytes,Data+0x100+i*0x40,name);
    Registration(i,Registrations[i],Records[i],parent);
    Bytes[Factories[i]]=0xe9;I32(Bytes,Factories[i]+1,0x20-5);
    Lea(Factories[i]+0x20,0x48,0x05,Vtables[i]);Put(Bytes,Factories[i]+0x27,0x48,0x89,0x03);
   }
   I64(Bytes,Vtables[3]+0x258,Base+Getters[3]);
  }
  public void Section(int index,string name,int start,int size,uint flags) {
   int offset=0x188+index*40;Put(HeaderBytes,offset,Encoding.ASCII.GetBytes(name));
   I32(HeaderBytes,offset+8,size);I32(HeaderBytes,offset+12,start);Put(HeaderBytes,offset+36,BitConverter.GetBytes(flags));
  }
  public void Lea(int at,byte prefix,byte register,int target) {Put(Bytes,at,prefix,0x8d,register);I32(Bytes,at+3,target-at-7);}
  public void Registration(int index,int at,int record,int parent) {
   Lea(at,0x48,0x15,Data+0x100+index*0x40);Put(Bytes,at+7,0x48,0x8d,0x4c,0x24,0x50,0xe8);I32(Bytes,at+13,Code+0x4900-at-17);
   Lea(at+0x11,0x48,0x15,Data+0x100+index*0x40);Put(Bytes,at+0x18,0x48,0x8d,0x4c,0x24,0x58,0x8b,0x18,0xe8);I32(Bytes,at+0x20,Code+0x4900-at-0x24);
   Lea(at+0x2c,0x48,0x0d,Factories[index]);Put(Bytes,at+0x33,0xc7,0x44,0x24,0x30);I32(Bytes,at+0x37,new int[]{0x15d0,0x3c90,0x158,0x9d0,0x1210}[index]);
   Lea(at+0x3b,0x4c,0x0d,parent);Put(Bytes,at+0x42,0x48,0x89,0x4c,0x24,0x28,0x44,0x8b,0xc3,0x8b,0x10);
   Lea(at+0x4c,0x48,0x0d,record);Put(Bytes,at+0x53,0xc6,0x44,0x24,0x20,0x00,0xe8);I32(Bytes,at+0x59,Code+0x4a00-at-0x5d);
  }
 }
 static void Relocations() {
  for(int seed=0;seed<8;seed++) {
   var image=new Image(seed);Require(Resolve(image.Profile),"relocated image "+seed);
   Require(Field(image.Profile,"PlayerType")==image.Base+image.Records[1],"player type");
   Require(Field(image.Profile,"PlayerVtable")==image.Base+image.Vtables[1],"player vtable");
   Require(Field(image.Profile,"ContextType")==image.Base+image.Records[2],"context type");
   Require(Field(image.Profile,"ContextVtable")==image.Base+image.Vtables[2],"context vtable");
   Require(Field(image.Profile,"RegionType")==image.Base+image.Records[3],"region type");
   Require(Field(image.Profile,"RegionVtable")==image.Base+image.Vtables[3],"region vtable");
   Require(Field(image.Profile,"LevelInfoType")==image.Base+image.Records[4],"level type");
  }
 }
 static void InvalidHeaders() {
  Action<Action<Image>,string> reject=delegate(Action<Image> change,string name) {var image=new Image(0);change(image);Require(Header(image.HeaderBytes,image.Base,image.Size)==null,name);};
  reject(i=>i.HeaderBytes[0]=0,"DOS signature");reject(i=>I32(i.HeaderBytes,0x3c,int.MaxValue),"PE bounds");
  reject(i=>U16(i.HeaderBytes,0x84,0x14c),"architecture");reject(i=>U16(i.HeaderBytes,0x98,0x10b),"PE format");
  reject(i=>I32(i.HeaderBytes,0xd0,i.Size-1),"image size");reject(i=>I32(i.HeaderBytes,0x188+40+12,i.Code),"overlapping sections");
  reject(i=>I32(i.HeaderBytes,0x188+8,int.MaxValue),"section overflow");reject(i=>I32(i.HeaderBytes,0x188+36,unchecked((int)0xe0000000)),"writable code");
  reject(i=>{U16(i.HeaderBytes,0x86,4);i.Section(3,".text",0xf000,0x1000,0x60000000);},"duplicate code section");
  var good=new Image(0);Require(Header(new byte[20],good.Base,good.Size)==null,"short headers");
  Require(Header(good.HeaderBytes,good.Base,int.MaxValue)==null,"bounded image allocation");
 }
 static void InvalidEvidence() {
  Action<Action<Image>,string> reject=delegate(Action<Image> change,string name) {var image=new Image(0);change(image);Require(!Resolve(image.Profile),name);};
  reject(i=>i.Bytes[i.Data+0x100+0x40-1]=(byte)'X',"exact terminated name");
  reject(i=>i.Bytes[i.Registrations[1]+0x53]=0x90,"changed registration");
  reject(i=>I64(i.Bytes,i.Records[1]+0x18,i.Base+i.Metadata+0x1800),"runtime parent differs");
  reject(i=>{int parent=i.Metadata+0x1800;i.Lea(i.Registrations[1]+0x3b,0x4c,0x0d,parent);I64(i.Bytes,i.Records[1]+0x18,i.Base+parent);},"player no longer derives from human");
  reject(i=>I32(i.Bytes,i.Registrations[2]+0x59,i.Code+0x4800-i.Registrations[2]-0x5d),"different registration constructor");
  reject(i=>I64(i.Bytes,i.Records[2],i.Base+i.Data+0x3100),"different native type header");
  reject(i=>I64(i.Bytes,i.Vtables[1],i.Base+i.Data),"vtable contains non-code");
  reject(i=>i.Bytes[i.Getters[0]+3]=0x50,"avatar layout changed");
  reject(i=>i.Bytes[i.Getters[1]]=0x90,"camera getter missing");
  reject(i=>i.Bytes[i.Getters[4]+3]=0xe0,"world position layout changed");
  reject(i=>i.Bytes[i.Getters[5]+3]=0xb0,"world matrix layout changed");
  reject(i=>i.Bytes[i.Getters[4]]=0x90,"world position getter missing");
  reject(i=>i.Bytes[i.Getters[5]]=0x90,"world matrix getter missing");
  reject(i=>I64(i.Bytes,i.Vtables[3]+0x258,i.Base+i.Getters[0]),"region getter disagrees");
  reject(i=>Array.Copy(i.Bytes,i.Getters[0],i.Bytes,i.Code+0x4700,11),"ambiguous avatar getter");
  reject(i=>Array.Copy(i.Bytes,i.Getters[4],i.Bytes,i.Code+0x4700,8),"ambiguous world position getter");
  reject(i=>Array.Copy(i.Bytes,i.Getters[5]-1,i.Bytes,i.Code+0x4700,9),"ambiguous leaf world matrix getter");
  reject(i=>I32(i.Bytes,i.Factories[1]+1,-5),"cyclic factory tail jump");
  reject(i=>{int extra=i.Metadata+0x2200;I64(i.Bytes,extra,i.Base+i.Data+0x3000);I64(i.Bytes,extra+0x18,i.Base+i.Records[0]);i.Registration(1,i.Code+0x800,extra,i.Records[0]);},"ambiguous registration");
  reject(i=>{int alternative=i.Data+0x2000;for(int x=0;x<12;x++)I64(i.Bytes,alternative+x*8,i.Base+i.Code+0x4800);i.Lea(i.Factories[1]+0x40,0x48,0x05,alternative);Put(i.Bytes,i.Factories[1]+0x47,0x48,0x89,0x03);},"ambiguous constructor vtable");
  var repeat=new Image(0);repeat.Registration(1,repeat.Code+0x800,repeat.Records[1],repeat.Records[0]);Require(Resolve(repeat.Profile),"identical registration aliases");
  var interior=new Image(0);Array.Copy(interior.Bytes,interior.Getters[5],interior.Bytes,interior.Code+0x4700,8);
  Put(interior.Bytes,interior.Code+0x46fe,0xcd,0x2c);Require(Resolve(interior.Profile),"interior assertion suffix is not a second leaf matrix getter");
 }
 static void BoundaryThunk() {
  var image=new Image(1);image.Lea(image.Registrations[1]+0x2c,0x48,0x0d,image.Code+0x5000-1);image.Bytes[image.Code+0x5000-1]=0xe9;
  Require(!Resolve(image.Profile),"truncated tail jump");
 }
 static int Main(string[] args) {
  try {
   if(args[0]=="relocations")Relocations();else if(args[0]=="headers")InvalidHeaders();else if(args[0]=="evidence")InvalidEvidence();else if(args[0]=="boundary")BoundaryThunk();else return 2;
   Console.WriteLine(args[0]+" passed");return 0;
  } catch(Exception error) {Console.Error.WriteLine(error);return 1;}
 }
}`;

test.before(() => {
  if (process.platform !== 'win32') return;
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(directory, 'profile-check.cs');
  fs.writeFileSync(source, harness);
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:ProfileChecks', `/out:${executable}`,
    path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), source], { stdio: 'pipe', windowsHide: true });
});

for (const [mode, description] of [
  ['relocations', 'resolves relocated sections, types, getters, factories and vtables under ASLR'],
  ['headers', 'rejects malformed, overlapping, ambiguous and incompatible PE images'],
  ['evidence', 'rejects conflicting registrations, changed ancestry, layouts and vtable evidence'],
  ['boundary', 'rejects truncated factory thunks without reading beyond the code section'],
]) {
  test(`native profile ${description}`, { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync(executable, [mode], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
