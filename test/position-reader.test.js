const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildPositionReader } = require('../scripts/build-position-reader');

const root = path.resolve(__dirname, '..');

test('position reader refuses output locations outside the build workspace', () => {
  assert.throws(() => buildPositionReader({ platform: 'win32', outputDir: path.resolve(root, '..', 'outside') }), /output must/);
});

test('position reader does not claim support on other platforms', () => {
  assert.throws(() => buildPositionReader({ platform: 'linux' }), /Windows only/);
});

test('Windows reader tracks with query/read rights, observes exit code 259, and respects denied reads',
  { skip: process.platform !== 'win32' }, () => {
    const directory = path.join(root, '.build', 'position-reader-access-tests');
    fs.mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, 'access-check.exe');
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:AccessChecks', `/out:${executable}`,
      path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'),
      path.join(__dirname, 'fixtures', 'windows-position-reader-access.cs')], { windowsHide: true, stdio: 'pipe' });
    const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

test('native reader rejects malformed input and non-game processes before scanning', { skip: process.platform !== 'win32' }, () => {
  const executable = buildPositionReader({ outputDir: path.join(root, '.build', 'position-reader-tests') });
  for (const args of [[], ['--pid', '-1'], ['--pid', String(process.pid), '--unexpected']]) {
    const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    const messages = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].status, 'invalid-arguments');
    assert.equal(messages[0].moduleHash, null);
    assert.equal(messages[0].bytesScanned, 0);
  }
  const result = spawnSync(executable, ['--pid', String(process.pid), '--probe'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  const message = JSON.parse(result.stdout.trim());
  assert.equal(message.status, 'wrong-process');
  assert.equal(message.moduleHash, null);
  assert.equal(message.bytesScanned, 0);
});

test('native transform checks reject malformed affine bases', { skip: process.platform !== 'win32' }, () => {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const directory = path.join(root, '.build', 'position-reader-tests');
  fs.mkdirSync(directory, { recursive: true });
  const harness = path.join(directory, 'transform-check.cs');
  const executable = path.join(directory, 'transform-check.exe');
  fs.writeFileSync(harness, `using System;
using System.Reflection;
internal static class TransformChecks {
 static bool Valid(float[] values) {
  return (bool)typeof(PlayerPositionReader).GetMethod("Orthonormal", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { values });
 }
 static bool Pose(float[] values, double expectedHeading) {
  object[] args = new object[] {values, null, null, 0.0};
  bool valid = (bool)typeof(PlayerPositionReader).GetMethod("TryWorldPose", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args);
  if (!valid) return false;
  float[] position = (float[])args[1]; float[] forward = (float[])args[2];
  return position[0] == 10 && position[1] == 20 && position[2] == 30 &&
   Math.Abs((double)args[3] - expectedHeading) < 0.001 && forward[0] == values[8] && forward[2] == values[10];
 }
 static int Main() {
  float[] identity = new float[] {1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,30,1};
  if (!Valid(identity)) return 1;
  if (!Pose(identity, 0)) return 6;
  float[] quarterTurn = new float[] {0,0,-1,0, 0,1,0,0, 1,0,0,0, 10,20,30,1};
  if (!Valid(quarterTurn)) return 2;
  if (!Pose(quarterTurn, 90)) return 7;
  float[] oppositeTurn = new float[] {0,0,1,0, 0,1,0,0, -1,0,0,0, 10,20,30,1};
  if (!Pose(oppositeTurn, -90)) return 8;
  float[] reflected = new float[] {-1,0,0,0, 0,1,0,0, 0,0,1,0, 10,20,30,1};
  if (Valid(reflected)) return 9;
  reflected[0] = float.NaN; if (Valid(reflected)) return 10;
  quarterTurn[0] = 1; if (Valid(quarterTurn)) return 3;
  identity[15] = 0; if (Valid(identity)) return 4;
  identity[15] = 1; identity[3] = 1; if (Valid(identity)) return 5;
  return 0;
 }
}`);
  execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:TransformChecks', `/out:${executable}`,
    path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), harness], { stdio: 'pipe', windowsHide: true });
  const result = spawnSync(executable, [], { windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});

test('native dungeon roots require safe upright consensus and refresh commands coalesce', { skip: process.platform !== 'win32' }, () => {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const directory = path.join(root, '.build', 'position-root-tests');
  fs.mkdirSync(directory, { recursive: true });
  const harness = path.join(directory, 'root-check.cs');
  const executable = path.join(directory, 'root-check.exe');
  fs.writeFileSync(harness, `using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
internal static class RootChecks {
 static Type Host = typeof(PlayerPositionReader);
 static Type Root = Host.GetNestedType("DungeonRoot", BindingFlags.NonPublic);
 static MethodInfo Method(string name) { return Host.GetMethod(name, BindingFlags.NonPublic | BindingFlags.Static); }
 static float[] Matrix(float x=0) { return new float[]{1,0,0,0, 0,1,0,0, 0,0,1,0, x,1000,0,1}; }
 static object Entry(string path,float[] matrix) {
  object root=Activator.CreateInstance(Root); Root.GetField("LevelPath").SetValue(root,path); Root.GetField("Matrix").SetValue(root,matrix); return root;
 }
 static IList Entries(params object[] values) {
  IList list=(IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(Root));foreach(object value in values)list.Add(value);return list;
 }
 static int Main() {
  string path="/SF/Levels/Procs/GladesofAndurin/GladesProcLevel",other="/SF/Levels/Procs/UnderCityCliffCave";
  if(!(bool)Method("ValidGeneratorPath").Invoke(null,new object[]{path}))return 1;
  foreach(string invalid in new string[]{"/SF/Levels/MidrathRedux",path+"/../Other",path+"/fingerprint.lp",path+new string('a',513),path+"\\n"})
   if((bool)Method("ValidGeneratorPath").Invoke(null,new object[]{invalid}))return 2;
  float[] tilted=new float[]{1,0,0,0,0,0,1,0,0,-1,0,0,0,1000,0,1};
  if(!(bool)Method("ValidDungeonMatrix").Invoke(null,new object[]{Matrix()}) || (bool)Method("ValidDungeonMatrix").Invoke(null,new object[]{tilted}))return 3;
  IList one=(IList)Method("ConsensusRoots").Invoke(null,new object[]{Entries(Entry(path,Matrix()),Entry(path,Matrix()),Entry(other,Matrix()))});
  if(one.Count!=2)return 4;
  IList conflict=(IList)Method("ConsensusRoots").Invoke(null,new object[]{Entries(Entry(path,Matrix()),Entry(path,Matrix(20)),Entry(path,Matrix()),Entry(other,Matrix()))});
  if(conflict.Count!=1 || (string)Root.GetField("LevelPath").GetValue(conflict[0])!=other)return 5;
  IList many=Entries();for(int i=0;i<40;i++)many.Add(Entry("/SF/Levels/Procs/Room"+i,Matrix()));
  if(((IList)Method("ConsensusRoots").Invoke(null,new object[]{many})).Count!=32)return 6;
  Type gateType=Host.GetNestedType("RootRefreshGate",BindingFlags.NonPublic);object gate=Activator.CreateInstance(gateType);
  Action request=()=>gateType.GetMethod("Request").Invoke(gate,null);Action complete=()=>gateType.GetMethod("Complete").Invoke(gate,null);
  Func<long,bool> start=milliseconds=>(bool)gateType.GetMethod("TryStart").Invoke(gate,new object[]{milliseconds});
  if(start(0))return 7;request();request();if(!start(0)||start(100))return 8;
  request();complete();if(start(29999)||!start(30000))return 9;complete();if(start(60000))return 10;
  request();if(!start(60000))return 11;complete();
  Console.WriteLine((string)Method("RootsJson").Invoke(null,new object[]{one}));return 0;
 }
}`);
  execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:RootChecks', `/out:${executable}`,
    path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), harness], { stdio: 'pipe', windowsHide: true });
  const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const entries = JSON.parse(result.stdout.trim());
  assert.equal(entries.length, 2);
  assert.equal(entries[0].source, 'stream-region');
  assert.equal(entries[0].matrix[13], 1000);
  assert.equal(entries[0].layoutCode, undefined, 'native reader never fabricates an unseen fingerprint');
});

test('loaded level frames bound the owned entity table and never truncate ambiguous clouds', { skip: process.platform !== 'win32' }, () => {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const directory = path.join(root, '.build', 'position-frame-tests');
  fs.mkdirSync(directory, { recursive: true });
  const harness = path.join(directory, 'frame-check.cs');
  const executable = path.join(directory, 'frame-check.exe');
  fs.writeFileSync(harness, `using System;
using System.Collections.Generic;
using System.Reflection;
internal static class FrameChecks {
 static MethodInfo Method(string name) { return typeof(PlayerPositionReader).GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static); }
 static float[] Matrix(float x=0) { return new float[]{1,0,0,0, 0,1,0,0, 0,0,1,0, x,1000,0,1}; }
 static bool Table(long pointer,uint bytes) { return (bool)Method("ValidFrameTable").Invoke(null,new object[]{pointer,bytes}); }
 static List<float[]> Frames(List<float[]> values) { return (List<float[]>)Method("ConsensusFrames").Invoke(null,new object[]{values}); }
 static int Main() {
  if(!Table(0x10000,8)||!Table(0x10000,65536*8))return 1;
  if(Table(0,8)||Table(-8,8)||Table(0x10001,8)||Table(0x10000,0)||Table(0x10000,9)||Table(0x10000,65536*8+8)||Table(long.MaxValue-7,16))return 2;
  float[] bad=Matrix();bad[3]=1;float[] reflected=Matrix();reflected[0]=-1;
  List<float[]> values=new List<float[]>{Matrix(),Matrix(),bad,reflected,null,Matrix(20)};
  List<float[]> valid=Frames(values);if(valid.Count!=2)return 3;
  List<float[]> limit=new List<float[]>();for(int i=0;i<64;i++)limit.Add(Matrix(i*10));
  if(Frames(limit).Count!=64)return 4;limit.Add(Matrix(640));if(Frames(limit).Count!=0)return 5;
  Console.WriteLine((string)Method("FramesJson").Invoke(null,new object[]{valid}));return 0;
 }
}`);
  execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:FrameChecks', `/out:${executable}`,
    path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), harness], { stdio: 'pipe', windowsHide: true });
  const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const frames = JSON.parse(result.stdout.trim());
  assert.equal(frames.length, 2);
  assert.equal(frames[0].source, 'level-info');
  assert.equal(frames[1].matrix[12], 20);
  assert.deepEqual(Object.keys(frames[0]).sort(), ['matrix', 'source']);
});

test('native frame walk resolves owned entity handles and rejects detached rooms', { skip: process.platform !== 'win32' }, () => {
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const directory = path.join(root, '.build', 'position-frame-walk-tests');
  fs.mkdirSync(directory, { recursive: true });
  const harness = path.join(directory, 'frame-walk-check.cs');
  const executable = path.join(directory, 'frame-walk-check.exe');
  fs.writeFileSync(harness, `using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
internal static class FrameWalkChecks {
 static readonly List<IntPtr> blocks=new List<IntPtr>();
 static long Allocate(int size) {IntPtr p=Marshal.AllocHGlobal(size);blocks.Add(p);Marshal.Copy(new byte[size],0,p,size);return p.ToInt64();}
 static void Pointer(long address,long value) {Marshal.WriteInt64(new IntPtr(address),value);}
 static void Number(long address,int value) {Marshal.WriteInt32(new IntPtr(address),value);}
 static object Call(Type type,object reader,string name,params object[] args) {
  return type.GetMethod(name,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic).Invoke(reader,args);
 }
 static int Count(Type type,object reader) {return ((IList)type.GetField("frames",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(reader)).Count;}
 static int Main() {
  object reader=null;
  try {
   // These fake runtime structures exist only in this test process. No game
   // process or supported-build validation is needed to exercise the walker.
   long module=Allocate(0x2cd2000),avatar=Allocate(0x200),context=Allocate(0x100),region=Allocate(0x210);
   long regionHandle=Allocate(8),table=Allocate(8),entityHandle=Allocate(8),entity=Allocate(0x200);
   Pointer(avatar+0x1e0,context);
   Pointer(context,module+0x21a4120);Pointer(context+8,module+0x28e21b0);Pointer(context+0x90,regionHandle);
   Pointer(regionHandle,region);Pointer(region,module+0x21a7b08);Pointer(region+8,module+0x28e33e0);
   Pointer(region+0x200,table);Number(region+0x208,8);Pointer(table,entityHandle);Pointer(entityHandle,entity);
   Pointer(entity,module+0x20ea738);Pointer(module+0x20ea738,module+0x1000);Pointer(entity+8,module+0x28c7650);
   Pointer(entity+0x1e0,context);
   Marshal.Copy(new float[]{1,0,0,0,0,1,0,0,0,0,1,0,10,990,20,1},0,new IntPtr(entity+0xa0),16);
   Type type=typeof(PlayerPositionReader).GetNestedType("Reader",BindingFlags.NonPublic);
   using(Process process=Process.GetCurrentProcess()) {
    reader=Activator.CreateInstance(type,new object[]{process});
    type.GetField("ModuleBase").SetValue(reader,module);
    // The walker fixture supplies an explicit synthetic profile; production
    // readers must recover and validate theirs before inspecting any objects.
    Type profileType=typeof(PlayerPositionReader).GetNestedType("ImageProfile",BindingFlags.NonPublic);
    object profile=Activator.CreateInstance(profileType);
    foreach(var field in new string[]{"Base","ContextType","ContextVtable","RegionType","RegionVtable","LevelInfoType"}) {
     long value=field=="Base"?module:module+(field=="ContextType"?0x28e21b0:field=="ContextVtable"?0x21a4120:field=="RegionType"?0x28e33e0:field=="RegionVtable"?0x21a7b08:0x28c7650);
     profileType.GetField(field).SetValue(profile,value);
    }
    profileType.GetField("Size").SetValue(profile,0x2cd2000);
    profileType.GetField("Code").SetValue(profile,0x1000);profileType.GetField("CodeSize").SetValue(profile,0x1ff0000);
    profileType.GetField("Data").SetValue(profile,0x1ff1000);profileType.GetField("DataSize").SetValue(profile,0x720000);
    type.GetField("profile",BindingFlags.Instance|BindingFlags.NonPublic).SetValue(reader,profile);
    long player=Allocate(0x150),avatarHandle=Allocate(8),camera=Allocate(0x80),cameraHandle=Allocate(8);
    long playerType=module+0x28e4000,objectVtable=module+0x20ea738;
    profileType.GetField("PlayerType").SetValue(profile,playerType);
    profileType.GetField("PlayerVtable").SetValue(profile,objectVtable);
    profileType.GetField("Metadata").SetValue(profile,0x2800000);profileType.GetField("MetadataSize").SetValue(profile,0x400000);
    ((HashSet<long>)type.GetField("playerTypes",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(reader)).Add(playerType);
    Pointer(player,objectVtable);Pointer(player+8,playerType);
    Pointer(player+0x148,avatarHandle);Pointer(avatarHandle,avatar);Pointer(avatar,objectVtable);
    Pointer(player+0xd0,cameraHandle);Pointer(cameraHandle,camera);Pointer(camera,objectVtable);
    float[] matrix={1,0,0,0,0,1,0,0,0,0,1,0,10,990,20,1};
    Marshal.Copy(matrix,0,new IntPtr(avatar+0xa0),16);
    object[] first={player,null,false};
    if((bool)Call(type,reader,"TryPose",first))return 7; // An invalid camera still rejects discovery.
    Type host=typeof(PlayerPositionReader),passType=host.GetNestedType("DiscoveryPass",BindingFlags.NonPublic);
    Type regions=typeof(List<>).MakeGenericType(host.GetNestedType("Region",BindingFlags.NonPublic));
    object loadingPass=Activator.CreateInstance(passType,new object[]{Activator.CreateInstance(regions),0L});
    byte[] headerWord=BitConverter.GetBytes(objectVtable);
    Call(type,reader,"Inspect",headerWord,headerWord.Length,player,loadingPass);
    if((int)passType.GetProperty("Count").GetValue(loadingPass,null)!=0)return 12;
    Marshal.Copy(matrix,0,new IntPtr(camera+0x30),16);
    Predicate<long> ready=p=>(bool)Call(type,reader,"TryPose",p,null,false);
    if((long)Call(passType,loadingPass,"SelectPlayer",ready)!=player)return 13;
    if(!(bool)Call(type,reader,"TryPose",first)||Count(type,reader)!=0)return 8;
    Type poseType=first[1].GetType();
    if(((float[])poseType.GetField("Position").GetValue(first[1]))[0]!=10)return 9;
    object[] next={player,null,true};
    if(!(bool)Call(type,reader,"TryPose",next)||Count(type,reader)!=1)return 1;
    // Reacquisition may occur while the previous avatar's frames are still cached.
    if(!(bool)Call(type,reader,"TryPose",first)||poseType.GetField("DungeonFrames").GetValue(first[1])!=null)return 10;
    // Either known header word can be the only one present in the chunk.
    for(int index=0;index<2;index++) {
     var pass=Activator.CreateInstance(passType,new object[]{Activator.CreateInstance(regions),0L});
     byte[] chunk=BitConverter.GetBytes(index==0?objectVtable:playerType);
     Call(type,reader,"Inspect",chunk,chunk.Length,player+8L*index,pass);
     if(!(bool)passType.GetMethod("Contains").Invoke(pass,new object[]{player}))return 11;
    }
    Pointer(entity+0x1e0,0);Call(type,reader,"RefreshDungeonFrames");Call(type,reader,"ReadDungeonFrames",avatar);
    if(Count(type,reader)!=0)return 2;
    Pointer(entity+0x1e0,context);Call(type,reader,"RefreshDungeonFrames");Call(type,reader,"ReadDungeonFrames",avatar);
    if(Count(type,reader)!=1)return 3;
    Pointer(entityHandle,0);Call(type,reader,"RefreshDungeonFrames");Call(type,reader,"ReadDungeonFrames",avatar);
    if(Count(type,reader)!=0)return 4;
    Pointer(entityHandle,entity);Call(type,reader,"RefreshDungeonFrames");Call(type,reader,"ReadDungeonFrames",avatar);
    if(Count(type,reader)!=1)return 5;
    Pointer(context+0x90,0);Call(type,reader,"ReadDungeonFrames",avatar);
    if(Count(type,reader)!=0)return 6;
   }
   return 0;
  } finally {if(reader!=null)((IDisposable)reader).Dispose();foreach(IntPtr p in blocks)Marshal.FreeHGlobal(p);}
 }
}`);
  execFileSync(compiler, ['/nologo', '/unsafe+', '/platform:x64', '/main:FrameWalkChecks', `/out:${executable}`,
    path.join(root, 'native', 'player-position-reader.cs'), path.join(root, 'native', 'world-drop-shiny.cs'), harness], { stdio: 'pipe', windowsHide: true });
  const result = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
