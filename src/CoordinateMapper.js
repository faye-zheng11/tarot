/**
 * 坐标映射工具
 * 将摄像头 2D 坐标转换为 3D 场景坐标
 */

export class CoordinateMapper {
  constructor(canvasWidth = 640, canvasHeight = 480, sceneConfig = {}) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    // Three.js 场景配置
    this.sceneConfig = {
      cameraZ: sceneConfig.cameraZ || 12,
      fov: sceneConfig.fov || 45,
      // 3D 空间的环卡位置圆形半径
      ringRadius: sceneConfig.ringRadius || 5,
      ...sceneConfig,
    };
  }

  /**
   * 将摄像头 2D 坐标转换为 3D 场景坐标
   * @param {number} videoX - 摄像头中的 X 坐标 (0-1)
   * @param {number} videoY - 摄像头中的 Y 坐标 (0-1)
   * @param {number} depth - 目标深度 (相对于摄像头)
   * @returns {Object} {x, y, z} 3D 坐标
   */
  videoToScene(videoX, videoY, depth = 5) {
    // 将摄像头中心映射为原点
    // 摄像头：(0.5, 0.5) -> 场景: (0, 0)
    const normalizedX = (videoX - 0.5) * 2; // -1 到 1
    const normalizedY = (videoY - 0.5) * 2; // -1 到 1

    // 计算视场角对应的场景宽度
    const vFOV = (this.sceneConfig.fov * Math.PI) / 180; // 转换为弧度
    const height = 2 * Math.tan(vFOV / 2) * this.sceneConfig.cameraZ;
    const width = height * (this.canvasWidth / this.canvasHeight);

    // 映射到 3D 场景
    const sceneX = normalizedX * (width / 2);
    const sceneY = -normalizedY * (height / 2); // Y 反转（视频向下，3D 向上）
    const sceneZ = depth;

    return { x: sceneX, y: sceneY, z: sceneZ };
  }

  /**
   * 将 3D 场景坐标投影回摄像头 2D 坐标（用于显示）
   * @param {number} sceneX - 3D 场景 X 坐标
   * @param {number} sceneY - 3D 场景 Y 坐标
   * @param {number} sceneZ - 3D 场景 Z 坐标
   * @returns {Object} {x, y} 摄像头坐标 (0-1)
   */
  sceneToVideo(sceneX, sceneY, sceneZ) {
    const vFOV = (this.sceneConfig.fov * Math.PI) / 180;
    const height = 2 * Math.tan(vFOV / 2) * this.sceneConfig.cameraZ;
    const width = height * (this.canvasWidth / this.canvasHeight);

    const videoX = (sceneX / (width / 2) + 1) / 2;
    const videoY = (-sceneY / (height / 2) + 1) / 2;

    return { x: videoX, y: videoY };
  }

  /**
   * 找到最近的卡牌（按手部位置）
   * @param {Object} handPos - 手部位置 {x, y}
   * @param {Array} cardPositions - 卡牌位置数组 [{id, angle, position: {x, y, z}}]
   * @returns {Object|null} 最近的卡牌或 null
   */
  findNearestCard(handPos, cardPositions) {
    if (!cardPositions || cardPositions.length === 0) return null;

    let nearest = null;
    let minDistance = Infinity;

    cardPositions.forEach((card) => {
      // 计算 2D 平面距离（忽略 Z）
      const dx = handPos.x - card.position.x;
      const dy = handPos.y - card.position.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < minDistance) {
        minDistance = distance;
        nearest = card;
      }
    });

    // 只有在距离足够近时才返回（捕捉范围）
    return minDistance < 1.5 ? nearest : null;
  }

  /**
   * 计算环形排列的卡牌 3D 位置
   * @param {number} index - 卡牌索引
   * @param {number} totalCards - 总卡牌数
   * @param {number} ringRadius - 圆形半径
   * @returns {Object} {x, y, z} 3D 坐标
   */
  getCardRingPosition(index, totalCards, ringRadius = null) {
    ringRadius = ringRadius || this.sceneConfig.ringRadius;
    const angle = (index / totalCards) * Math.PI * 2;
    return {
      x: Math.sin(angle) * ringRadius,
      y: 0,
      z: Math.cos(angle) * ringRadius,
      angle,
    };
  }
}

export default CoordinateMapper;
