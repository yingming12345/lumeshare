// 背景音乐播放器（隐藏窗口内运行，无任何界面）
(function () {
  var audio = null;
  var wantPlay = false;

  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.loop = true;
      audio.preload = 'auto';
      audio.addEventListener('playing', function () {
        if (window.lumeMusic) window.lumeMusic.report({ playing: true });
      });
      audio.addEventListener('pause', function () {
        if (window.lumeMusic) window.lumeMusic.report({ playing: false });
      });
      audio.addEventListener('error', function () {
        var msg = '音频解码失败或文件不可用';
        try {
          if (audio.error && audio.error.code === 4) msg = '不支持的音频格式';
          if (audio.error && audio.error.code === 2) msg = '网络或文件读取失败';
        } catch (e) {
          /* ignore */
        }
        if (window.lumeMusic) window.lumeMusic.report({ playing: false, error: msg });
      });
    }
    return audio;
  }

  function tryPlay() {
    var a = ensureAudio();
    var p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        // 极少数情况下需要稍后重试（例如隐藏窗口尚未就绪）
        setTimeout(function () {
          if (wantPlay) {
            try {
              a.play();
            } catch (e) {
              /* ignore */
            }
          }
        }, 1200);
      });
    }
  }

  function play(data) {
    wantPlay = true;
    var a = ensureAudio();
    if (typeof data.volume === 'number') a.volume = Math.max(0, Math.min(1, data.volume));
    a.loop = data.loop !== false;
    if (data.url) a.src = data.url;
    tryPlay();
  }

  function stop() {
    wantPlay = false;
    try {
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    } catch (e) {
      /* ignore */
    }
  }

  if (window.lumeMusic) {
    window.lumeMusic.onPlay(play);
    window.lumeMusic.onStop(stop);
  }
})();
