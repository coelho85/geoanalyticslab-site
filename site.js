document.getElementById('y').textContent = new Date().getFullYear();

(function () {
  var nav = document.querySelector('header.nav');
  var toggle = nav.querySelector('.menu-toggle');

  function setOpen(open) {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }

  toggle.addEventListener('click', function () {
    setOpen(!nav.classList.contains('open'));
  });
  nav.querySelectorAll('ul a').forEach(function (link) {
    link.addEventListener('click', function () { setOpen(false); });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      setOpen(false);
      toggle.focus();
    }
  });
})();

(function () {
  var art = document.querySelector('.hero-art');
  if (art && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    art.pauseAnimations();
    art.setCurrentTime(0);
  }
})();

(function () {
  var art = document.querySelector('.hero-art');
  var handle = art && art.querySelector('.swipe-handle');
  if (!handle) return;

  var swipe = art.querySelector('.swipe');
  var divider = swipe.querySelector('.div');
  var clip = art.querySelector('#swipeClip rect');
  var animations = art.querySelectorAll('.swipe > animateTransform, #swipeClip animate');

  var labels = swipe.querySelectorAll('text'); // TRUE COLOR, NDVI

  var REST = 300; // bar position, in viewBox units
  var MIN = Number(handle.getAttribute('data-min') || 40);
  var MAX = Number(handle.getAttribute('data-max') || 480);
  var IMAGE_OFFSET = 150; // the imagery group is translated by -150
  var KEY_STEP = 10;

  var position = REST;
  var interacted = false;
  var dragging = false;
  var grabOffset = 0;

  function toViewBoxX(clientX) {
    var box = art.getBoundingClientRect();
    return (clientX - box.left) * 500 / box.width;
  }

  function setPosition(x) {
    position = Math.min(MAX, Math.max(MIN, x));
    swipe.setAttribute('transform', 'translate(' + (position - REST) + ' 0)');
    clip.setAttribute('x', position + IMAGE_OFFSET);
    handle.setAttribute('aria-valuenow', Math.round((position - MIN) / (MAX - MIN) * 100));
    // Near the edges a label has no room beside the bar, and its side is barely visible anyway.
    labels[0].style.visibility = position < 60 ? 'hidden' : '';
    labels[1].style.visibility = position > 470 ? 'hidden' : '';
  }

  // The first interaction ends the automatic sweep, keeping the bar where it was.
  function takeOver() {
    if (interacted) return;
    interacted = true;
    var current = toViewBoxX(divider.getBoundingClientRect().left);
    animations.forEach(function (animation) { animation.remove(); });
    setPosition(current);
  }

  handle.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    takeOver();
    dragging = true;
    grabOffset = toViewBoxX(event.clientX) - position;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', function (event) {
    if (dragging) setPosition(toViewBoxX(event.clientX) - grabOffset);
  });
  handle.addEventListener('lostpointercapture', function () {
    dragging = false;
    handle.classList.remove('dragging');
  });

  handle.addEventListener('keydown', function (event) {
    var keys = { ArrowLeft: -KEY_STEP, ArrowDown: -KEY_STEP, ArrowRight: KEY_STEP, ArrowUp: KEY_STEP };
    if (event.key !== 'Home' && event.key !== 'End' && !keys[event.key]) return;
    event.preventDefault();
    takeOver();
    if (event.key === 'Home') setPosition(MIN);
    else if (event.key === 'End') setPosition(MAX);
    else setPosition(position + keys[event.key]);
  });
})();
