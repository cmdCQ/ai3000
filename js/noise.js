/* noise canvas — shared across AI三千问 pages */
(function() {
  const canvas = document.getElementById('noise');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  function frame() {
    const imageData = ctx.createImageData(w, h);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 40;
      data[i] = v; data[i+1] = v; data[i+2] = v; data[i+3] = 30;
    }
    ctx.putImageData(imageData, 0, 0);
    requestAnimationFrame(frame);
  }
  frame();
})();
