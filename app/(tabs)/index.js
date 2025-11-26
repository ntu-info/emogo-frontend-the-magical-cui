// app/(tabs)/index.js
import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Button,
  TouchableOpacity,
  Alert,
  StyleSheet,
} from 'react-native';
import { CameraView, useCameraPermissions, Camera } from 'expo-camera';
import * as Location from 'expo-location';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';

// 同一顆 DB：settings.js 也會用到這顆 data.db
const db = SQLite.openDatabaseSync('data.db');

// 建表
async function initDb() {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      mood INTEGER,
      videoUri TEXT,
      lat REAL,
      lng REAL
    );
  `);
}


// --------- 錄影儲存用的資料夾設定 ---------
const VIDEO_DIR = FileSystem.documentDirectory + 'videos/';

// 確保 VIDEO_DIR 存在（沒有就建立）
async function ensureVideoDir() {
  try {
    const info = await FileSystem.getInfoAsync(VIDEO_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(VIDEO_DIR, { intermediates: true });
    }
  } catch (e) {
    console.log('ensureVideoDir error', e);
  }
}

export default function HomeScreen() {
  // 相機權限 hook：permission = 狀態, requestPermission = 去要權限的 function
  const [permission, requestPermission] = useCameraPermissions();

  const [hasLocPerm, setHasLocPerm] = useState(null);   // 定位權限有沒有拿到
  const [mood, setMood] = useState(null);               // 目前選到的心情 1~5
  const cameraRef = useRef(null);                       // 拿到 Camera 實體用來 recordAsync
  const [camType, setCamType] = useState('front'); // 一開始用前鏡頭
  const [isRecording, setIsRecording] = useState(false);
  const [lastVideoUri, setLastVideoUri] = useState(null); // 最近一次錄到的影片
  const [lastCoords, setLastCoords] = useState(null);     // 最近一次錄影的 GPS { lat, lng }



  
useEffect(() => {
  (async () => {
    // 1. 初始化資料庫
    await initDb();

    // 2. 相機權限（用 hook）
    if (!permission?.granted) {
      const p = await requestPermission();   // ➜ 這裡會觸發系統權限視窗
      if (!p.granted) {
        Alert.alert('需要相機權限才能錄影');
        return; // 相機都沒權限了，後面就不用做了
      }
    }

    // 3. 麥克風權限（錄影要聲音）
    const mic = await Camera.requestMicrophonePermissionsAsync();
    if (mic.status !== 'granted') {
      Alert.alert('需要麥克風權限才能錄影');
      // 這裡看你要不要 return；如果沒聲音可以接受，就不要 return
    }

    // 4. 定位權限
    const loc = await Location.requestForegroundPermissionsAsync();
    setHasLocPerm(loc.status === 'granted');
  })();
  // 這裡其實用 [requestPermission] 或 [] 都可以
  // 不一定要把 permission 放進來，以免不停重跑
}, [requestPermission]);

  // 還在載入權限狀態時先顯示一個簡單畫面
  if (!permission) {
    return (
      <View style={styles.container}>
        <Text>載入中…</Text>
      </View>
    );
  }

// 只負責「錄 1 秒 + 更新暫存的 videoUri / GPS」不寫 DB


const handleRecordOnly = async () => {
  if (!permission?.granted || !hasLocPerm) {
    Alert.alert('缺少相機或定位權限');
    return;
  }

  if (isRecording) return; // 已在錄影就不要重複

  try {
    setIsRecording(true);

    // 1) 錄 1 秒 vlog（存在 Camera 的 cache 裡）
    const video = await cameraRef.current?.recordAsync({
      maxDuration: 1,
      mute: false,
    });

    if (!video) {
      Alert.alert('錄影失敗');
      return;
    }

    // 2) 把暫存檔搬到我們自己的永久資料夾
    await ensureVideoDir();
    const ts = new Date().toISOString();                      // 例如 2025-11-26T09:35:13.123Z
    const safeTs = ts.replace(/[:.]/g, '-');                  // 不能有冒號
    const destPath = VIDEO_DIR + `sample_${safeTs}.mp4`;      // file://.../videos/sample_2025-11-26T09-35-13-123Z.mp4

    await FileSystem.moveAsync({
      from: video.uri,
      to: destPath,
    });

    // 3) 抓位置
    const loc = await Location.getCurrentPositionAsync({});
    const { latitude, longitude } = loc.coords;

    // 4) 更新暫存 state（之後儲存時就寫這個永久路徑）
    setLastVideoUri(destPath);
    setLastCoords({ lat: latitude, lng: longitude });

    Alert.alert('錄影完成', '當前影片已暫存，要按「儲存」才記錄成功喔');
  } catch (e) {
    console.log(e);
    Alert.alert('錄影時發生錯誤', String(e));
  } finally {
    setIsRecording(false);
  }
};


// 把目前的 mood + 暫存影片 + 暫存 GPS 寫進 DB
const handleSaveSample = async () => {
  if (!mood) {
    Alert.alert('請先選擇心情');
    return;
  }
  if (!lastVideoUri || !lastCoords) {
    Alert.alert('目前沒有可以存的錄影，請先按「錄 1 秒」');
    return;
  }

  try {
    const ts = new Date().toISOString();

    await db.runAsync(
      'INSERT INTO samples (ts, mood, videoUri, lat, lng) VALUES (?, ?, ?, ?, ?);',
      [ts, mood, lastVideoUri, lastCoords.lat, lastCoords.lng]
    );

    Alert.alert('已存成一筆資料');

    // 存完之後清掉暫存，逼自己下一筆要重錄
    setMood(null);
    setLastVideoUri(null);
    setLastCoords(null);
  } catch (e) {
    console.log(e);
    Alert.alert('寫入資料庫時發生錯誤', String(e));
  }
};



  return (
    <View style={styles.container}>
      <Text style={styles.title}>記錄下你的心情吧！</Text>

      {/* Camera 預覽區 */}
      <View style={styles.cameraBox}>
        {permission.granted ? (
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing={camType}
            mode="video" // 告訴他要錄影
          />
        ) : (
          <Text>尚未取得相機權限</Text>
        )}
      </View>

      {/* 心情按鈕 1~5 */}
      <Text style={styles.text}>請從 1 到 5 分對你當下的心情評分，數字越大代表整體情緒越正向。</Text>
      <View style={styles.moodRow}>
        {[1, 2, 3, 4, 5].map(v => (
          <TouchableOpacity
            key={v}
            style={[
              styles.moodBtn,
              mood === v && styles.moodBtnActive,
            ]}
            onPress={() => setMood(v)}
          >
            <Text>{v}</Text>
          </TouchableOpacity>
        ))}
      </View>

    {/* 錄影：只更新暫存 */}
    <Button
      title={isRecording ? '錄影中…' : '開始錄影'}
      onPress={handleRecordOnly}
      disabled={isRecording}
    />

    {/* 存檔：把暫存內容 + mood 寫進 DB */}
    <Button title="儲存" onPress={handleSaveSample} />

    {/* 切換前/後鏡頭 */}
    <Button
      title="切換前/後鏡頭"
      onPress={() => {
        setCamType(prev => (prev === 'front' ? 'back' : 'front'));
      }}
    />
    {/* 小提示：有沒有暫存的影片 */}
    {lastVideoUri && (
      <Text style={{ marginTop: 8, textAlign: 'center' }}>
        已暫存一段影片，記得按「儲存」喔
      </Text>
    )}


    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, justifyContent: 'flex-start', gap: 16 },
  title: { fontSize: 24, textAlign: 'center', marginVertical: 8 },
  cameraBox: {
    height: 220,
    borderWidth: 1,
    borderColor: '#ccc',
    overflow: 'hidden',
  },
  camera: { flex: 1 },
  moodRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 12,
  },
  moodBtn: {
    flex: 1,
    marginHorizontal: 4,
    padding: 10,
    borderWidth: 1,
    borderRadius: 4,
    alignItems: 'center',
  },
  moodBtnActive: { backgroundColor: '#cde' },
});
