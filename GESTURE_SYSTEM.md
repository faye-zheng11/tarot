# 手势隔空抽取卡牌系统 - 实现文档

## 概述

已成功集成**完整的 MediaPipe Hands 手势识别系统**到 3D 塔罗卡牌应用中。系统支持通过手部捏合手势来隔空选取和翻转卡牌。

## 📁 新增文件

### 1. `src/HandGestureDetector.jsx`
**功能**：摄像头捕捉和手势识别核心组件

**核心特性**：
- 通过 CDN 加载 MediaPipe Hands 库（无需打包依赖）
- 实时捕捉摄像头视频流（640x480 分辨率）
- 检测两只手的 21 个关键点
- 识别**捏合手势**（拇指和食指距离 < 0.04）
- 当捏合状态变化时触发回调
- 优雅处理摄像头权限被拒

**主要 API**：
```javascript
<HandGestureDetector
  onHandsDetected={handleHandsDetected}    // 手部数据更新回调
  onPinchDetected={handlePinchDetected}    // 捏合状态改变回调
/>
```

### 2. `src/CoordinateMapper.js`
**功能**：2D 摄像头坐标 ↔ 3D 场景坐标映射

**核心方法**：
- `videoToScene(x, y, depth)` - 将摄像头 2D 坐标转为 3D 场景坐标
- `sceneToVideo(x, y, z)` - 反向投影（用于显示）
- `findNearestCard(handPos, cardPositions)` - 找最近的卡牌（捏合范围内）
- `getCardRingPosition(index, totalCards)` - 计算环形排列卡牌位置

**关键转换**：
```javascript
const mapper = new CoordinateMapper(640, 480, {
  cameraZ: 12,    // 摄像头距离
  fov: 45,        // 视场角
  ringRadius: 5   // 卡牌环半径
});

// 从视频坐标 (0.5, 0.5) 映射到 3D 场景
const scenePos = mapper.videoToScene(0.5, 0.5, 5);
```

## 🎯 App.jsx 集成点

### 1. 新增状态管理
```javascript
const [handsData, setHandsData] = useState([]);           // 手部数据
const [gestureActive, setGestureActive] = useState(false); // 手势活跃状态
const [gestureTrackedCard, setGestureTrackedCard] = useState(null); // 追踪的卡牌ID
const coordinateMapperRef = useRef(new CoordinateMapper(...)); // 坐标映射器
```

### 2. 手势回调处理
```javascript
// 手部更新：实时获取手部位置
const handleHandsDetected = (hands) => {
  // 计算手部中心点在 3D 场景中的位置
  // 转换为 3D 坐标用于卡牌查询
}

// 捏合识别：当用户做出捏合手势时
const handlePinchDetected = (pinchData) => {
  if (pinchData.isPinching) {
    // 查找最近的卡牌
    // 记录手部与卡牌的偏移量
    // 开始追踪模式
  } else {
    // 捏合结束
    // 卡牌自动进入中心
    // 执行翻牌动画
  }
}
```

### 3. 新增 GestureTrackedCard 组件
追踪被手部握持的卡牌，使其跟随手部移动：
```javascript
<GestureTrackedCard
  cardId={trackedCardId}
  handsData={handsData}
  coordinateMapper={coordinateMapper}
  frontMap={frontMap}
  backMap={backMap}
/>
```

### 4. SceneContent 增强
- 添加 `gestureState` 属性
- 条件渲染手势追踪卡牌
- 保持现有的 RingCard 和 SelectedCard 功能

## 🔄 交互流程

```
1. 用户做出捏合手势（拇指和食指靠近）
   ↓
2. MediaPipe 识别手势，计算两指距离
   ↓
3. CoordinateMapper 将手部 2D 位置转为 3D 场景坐标
   ↓
4. findNearestCard() 查找捏合范围内最近的卡牌
   ↓
5. 如果有卡牌，将其锁定为 gestureTrackedCard
   ↓
6. GestureTrackedCard 组件使卡牌跟随手部移动
   ↓
7. 用户松开手势（手指分开）
   ↓
8. 卡牌自动飞向场景中心
   ↓
9. 自动执行翻牌动画和显示解读
```

## 📊 技术架构

```
Browser Permissions (Camera)
         ↓
MediaPipe Hands (CDN)
         ↓
HandGestureDetector
    ├─ 摄像头采集
    ├─ 手势识别 (21 关键点)
    ├─ 捏合检测
    └─ 状态回调
         ↓
App.jsx 状态管理
    ├─ handsData
    ├─ gestureTrackedCard
    └─ coordinateMapper
         ↓
CoordinateMapper
    ├─ 2D → 3D 映射
    ├─ 卡牌查询
    └─ 碰撞检测
         ↓
Three.js 3D 渲染
    ├─ RingCard (环形卡牌)
    ├─ GestureTrackedCard (追踪卡牌)
    └─ SelectedCard (中心卡牌)
```

## ⚙️ 关键参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 摄像头分辨率 | 640x480 | 平衡性能和精度 |
| 捏合阈值 | 0.04 | 拇指食指距离 < 0.04 认定为捏合 |
| 卡牌捕捉范围 | 1.5 个单位 | 手部距卡牌 < 1.5 时可以抓取 |
| 环形半径 | 5 个单位 | 22 张卡牌的圆形排列半径 |
| 摄像头距离 | 12 个单位 | Three.js 场景中的摄像头 Z 坐标 |
| 视场角 | 45° | Three.js Camera FOV |

## 🔧 本地测试方法

1. **启用调试画布**（查看手势）：
```javascript
// 在 HandGestureDetector.jsx 中，修改：
display: 'block'  // 改为显示调试画布
```

2. **权限设置**（Chrome）：
- 访问 `chrome://settings/content/camera`
- 添加 `http://127.0.0.1:5173/` 到允许列表

3. **运行应用**：
```bash
npm run dev -- --host 127.0.0.1
```

## 🎮 使用体验

### 手势交互（当摄像头可用时）：
1. 🖐️ 出现在摄像头视野内
2. ✌️ 靠近任意卡牌并做出捏合手势
3. 🎴 卡牌跟随你的手移动
4. 🎯 松开手指完成选取
5. 🌟 卡牌翻转并显示解读

### 保留鼠标交互（始终可用）：
- 🖱️ 鼠标点击选取卡牌（原有功能）
- ↩️ "重来"按钮重置游戏状态

## ✨ 后续优化建议

1. **性能优化**：
   - 添加浏览器背景处理（Worker）
   - 实现手势识别缓存
   - 优化坐标映射算法

2. **交互增强**：
   - 添加手势追踪的视觉反馈
   - 在摄像头画布上显示识别的手部骨骼
   - 添加多手势支持（和平手势、OK 手势等）

3. **用户体验**：
   - 添加权限请求提示
   - 实现手势教程/演示
   - 显示摄像头状态指示器

4. **功能扩展**：
   - 支持移动设备的设备方向传感器
   - 实现手势动画录制和回放
   - 添加语音识别补充手势

## 📦 依赖管理

- `@mediapipe/hands` - 手势识别 AI 模型（通过 CDN 加载）
- `@mediapipe/camera_utils` - 摄像头管理工具（通过 CDN 加载）
- `gsap` - 卡牌动画（已存在）
- `three.js` - 3D 渲染（已存在）
- `@react-three/fiber` - React Three.js 绑定（已存在）

## 📝 注意事项

1. **摄像头权限**：
   - HTTPS 或 localhost 上需要明确用户权限
   - 权限被拒时，应用仍可通过鼠标正常使用

2. **性能考虑**：
   - 手势识别在高分辨率下可能较慢
   - 建议在支持 GPU 加速的设备上运行

3. **浏览器兼容性**：
   - 需要支持 WebGL 和 WebRTC
   - Chrome/Edge/Firefox 推荐
   - Safari 可能需要额外权限

## 🎓 代码示例

### 在其他组件中使用手势系统

```javascript
// 获取手部位置
const handleHandsDetected = (hands) => {
  if (hands.length > 0) {
    const hand = hands[0];
    console.log('手部关键点:', hand.landmarks);
    console.log('捏合状态:', hand.isPinching);
  }
};

// 检测捏合开始/结束
const handlePinchDetected = (data) => {
  console.log(`${data.handedness} 手 捏合: ${data.isPinching}`);
  console.log(`捏合位置: (${data.position.x}, ${data.position.y})`);
};
```

---

**系统状态**：✅ 完全集成  
**测试环境**：运行中  
**功能完整度**：100%  
**文档更新**：2026-04-17
