// app/(tabs)/settings.js
import React, { useState } from 'react';
import {
  View,
  Text,
  Button,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import * as Notifications from 'expo-notifications';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';

const db = SQLite.openDatabaseSync('data.db');
const VIDEO_DIR = FileSystem.documentDirectory + 'videos/';
const SAF = FileSystem.StorageAccessFramework;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const pad2 = (n) => n.toString().padStart(2, '0');



async function ensureVideoDir() {
  const info = await FileSystem.getInfoAsync(VIDEO_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(VIDEO_DIR, { intermediates: true });
  }
}

/** =========  1. 匯出「只有 CSV」  ========= */
async function exportToCsv() {
  try {
    const rows = await db.getAllAsync('SELECT * FROM samples;');

    if (!rows || rows.length === 0) {
      Alert.alert('目前沒有資料可以匯出');
      return;
    }

    let csv = 'id,ts,mood,videoUri,lat,lng\n';
    for (const r of rows) {
      const line = [
        r.id,
        r.ts,
        r.mood,
        JSON.stringify(r.videoUri ?? ''),
        r.lat,
        r.lng,
      ].join(',');
      csv += line + '\n';
    }

    const fileUri = FileSystem.documentDirectory + 'samples.csv';
    await FileSystem.writeAsStringAsync(fileUri, csv, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: '匯出 samples.csv',
      });
    } else {
      Alert.alert('此裝置無法使用分享功能', `檔案位置：${fileUri}`);
    }
  } catch (err) {
    console.log('exportToCsv error', err);
    Alert.alert('匯出失敗', String(err));
  }
}

/** =========  2. 匯出 CSV + 對應影片到一個資料夾  =========
 *  Android：使用 StorageAccessFramework，請使用實機測。
 *  會請使用者選一個資料夾，裡面會有：
 *    - samples.csv  (欄位含 videoFilename)
 *    - 多個 mp4，檔名 sample_YYYY-MM-DDTHH-mm-ss.mp4
 */
async function exportCsvAndVideos() {
  try {
    const rows = await db.getAllAsync('SELECT * FROM samples;');
    if (!rows || rows.length === 0) {
      Alert.alert('目前沒有資料可以匯出');
      return;
    }

    // 1) 讓使用者選一個目標資料夾（例如 Download/Sample）
    const permissions = await SAF.requestDirectoryPermissionsAsync();
    if (!permissions.granted) {
      Alert.alert('已取消匯出');
      return;
    }
    const dirUri = permissions.directoryUri;

    // 2) 先寫 CSV
    let csv = 'id,ts,mood,videoUri,lat,lng\n';
    for (const r of rows) {
      const line = [
        r.id,
        r.ts,
        r.mood,
        JSON.stringify(r.videoUri ?? ''),
        r.lat,
        r.lng,
      ].join(',');
      csv += line + '\n';
    }

    const csvFileUri = await SAF.createFileAsync(
      dirUri,
      'samples.csv',
      'text/csv'
    );
    await FileSystem.writeAsStringAsync(csvFileUri, csv, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    // 3) 再把每一筆的影片複製成實體 mp4 檔，成功後順便刪掉 app 內那一份
    for (const r of rows) {
      if (!r.videoUri) continue;

      try {
        // 先確認這個路徑的檔案還存在
        const info = await FileSystem.getInfoAsync(r.videoUri);
        if (!info.exists) {
          console.log('video not found, skip id =', r.id, r.videoUri);
          continue;
        }

        // 讀原始影片成 base64
        const base64Video = await FileSystem.readAsStringAsync(r.videoUri, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // 檔名用時間戳，避開 : . 這類字元
        const safeTs = r.ts.replace(/[:.]/g, '-');
        const destVideoUri = await SAF.createFileAsync(
          dirUri,
          `sample_${safeTs}.mp4`,
          'video/mp4'
        );

        // 寫入目標資料夾
        await FileSystem.writeAsStringAsync(destVideoUri, base64Video, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // ✅ 複製成功後，把 app 內的那份刪掉，避免一直佔空間
        await FileSystem.deleteAsync(r.videoUri, { idempotent: true });
      } catch (e) {
        console.log('skip video id =', r.id, 'because:', e);
        // 這一筆失敗就略過，其他照常匯出
        continue;
      }
    }

    Alert.alert(
      '匯出完成',
      'samples.csv 與所有影片已寫入選取的資料夾，且已清除 app 內影片暫存。'
    );
  } catch (err) {
    console.log('exportCsvAndVideos error', err);
    Alert.alert('匯出失敗', String(err));
  }
}


/** =========  3. 根據「三組時間」排程每日提醒  ========= */
async function scheduleDailyReminders(reminders) {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert('通知權限被拒絕');
    return;
  }

  // 先清空之前排程，避免一直疊加
  await Notifications.cancelAllScheduledNotificationsAsync();

  for (const { hour, minute } of reminders) {
    if (hour == null || minute == null) continue;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Time to log a sample',
        body: '請紀錄心情 + vlog + GPS',
      },
      trigger: {
        hour,
        minute,
        repeats: true, // ➜ 每天這個時間都會提醒
      },
    });
  }

  Alert.alert('提醒已設定', '會依照你選的三個時間，每天發通知。');
}

/** =========  4. Settings 畫面元件  ========= */
export default function SettingsScreen() {
  // 三組提醒時間：預設 09:00 / 15:00 / 21:00
  const [reminders, setReminders] = useState([
    { hour: 9, minute: 0 },
    { hour: 15, minute: 0 },
    { hour: 21, minute: 0 },
  ]);

  const updateReminder = (index, key, value) => {
    setReminders(prev =>
      prev.map((r, i) =>
        i === index ? { ...r, [key]: value } : r
      )
    );
  };

  const handleSchedulePress = async () => {
    await scheduleDailyReminders(reminders);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.screenTitle}>Settings</Text>

      <Text style={styles.sectionTitle}>每日提醒時間</Text>

      {/* 提醒 1 */}
      <View style={styles.row}>
        <Text style={styles.rowLabel}>
          提醒 1　{pad2(reminders[0].hour)}:{pad2(reminders[0].minute)}
        </Text>
        <Picker
          style={styles.picker}
          selectedValue={reminders[0].hour}
          onValueChange={v => updateReminder(0, 'hour', v)}
          dropdownIconColor="#000"
        >
          {HOURS.map(h => (
            <Picker.Item key={h} label={pad2(h)} value={h} color="#000" />
          ))}
        </Picker>
        <Text style={styles.colon}>:</Text>
        <Picker
          style={styles.picker}
          selectedValue={reminders[0].minute}
          onValueChange={v => updateReminder(0, 'minute', v)}
          dropdownIconColor="#000"
        >
          {MINUTES.map(m => (
            <Picker.Item key={m} label={pad2(m)} value={m} color="#000" />
          ))}
        </Picker>
      </View>

      {/* 提醒 2 */}
      <View style={styles.row}>
        <Text style={styles.rowLabel}>
          提醒 2　{pad2(reminders[1].hour)}:{pad2(reminders[1].minute)}
        </Text>
        <Picker
          style={styles.picker}
          selectedValue={reminders[1].hour}
          onValueChange={v => updateReminder(1, 'hour', v)}
          dropdownIconColor="#000"
        >
          {HOURS.map(h => (
            <Picker.Item key={h} label={pad2(h)} value={h} color="#000" />
          ))}
        </Picker>
        <Text style={styles.colon}>:</Text>
        <Picker
          style={styles.picker}
          selectedValue={reminders[1].minute}
          onValueChange={v => updateReminder(1, 'minute', v)}
          dropdownIconColor="#000"
        >
          {MINUTES.map(m => (
            <Picker.Item key={m} label={pad2(m)} value={m} color="#000" />
          ))}
        </Picker>
      </View>

      {/* 提醒 3 */}
      <View style={styles.row}>
        <Text style={styles.rowLabel}>
          提醒 3　{pad2(reminders[2].hour)}:{pad2(reminders[2].minute)}
        </Text>
        <Picker
          style={styles.picker}
          selectedValue={reminders[2].hour}
          onValueChange={v => updateReminder(2, 'hour', v)}
          dropdownIconColor="#000"
        >
          {HOURS.map(h => (
            <Picker.Item key={h} label={pad2(h)} value={h} color="#000" />
          ))}
        </Picker>
        <Text style={styles.colon}>:</Text>
        <Picker
          style={styles.picker}
          selectedValue={reminders[2].minute}
          onValueChange={v => updateReminder(2, 'minute', v)}
          dropdownIconColor="#000"
        >
          {MINUTES.map(m => (
            <Picker.Item key={m} label={pad2(m)} value={m} color="#000" />
          ))}
        </Picker>
      </View>

      <Button
        title="儲存提醒設定並啟用通知"
        onPress={handleSchedulePress}
      />

      <View style={{ height: 24 }} />

      <Button title="匯出 CSV 資料" onPress={exportToCsv} />
      <View style={{ marginTop: 8 }} />
      <Button
        title="匯出 CSV + 影片到資料夾"
        onPress={exportCsvAndVideos}
      />

      <Text style={styles.tip}>
        匯出後會將不同時間心情與位置的紀錄存入samples.csv，並與已記錄之影片存到同一資料夾。
      </Text>
    </View>
  );
}


/** =========  5. 樣式  ========= */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    paddingTop: 32,
    backgroundColor: '#f5f5f5',
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '500',
    marginBottom: 8,
  },
  row: {
  flexDirection: 'row',
  alignItems: 'center',   // 保證垂直置中
  marginBottom: 8,
  },
  rowLabel: {
    width: 80,
    fontSize: 16,
  },
  colon: {
    marginHorizontal: 4,
    fontSize: 16,
  },
  picker: {
    flex: 1,
    height: 52,
  },
  tip: {
    marginTop: 16,
    fontSize: 12,
    color: '#444',
  },
});
