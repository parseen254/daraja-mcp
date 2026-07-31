/* Progressive enhancement only. Every piece of content works without this
   file: the theme follows prefers-color-scheme, navigation is a checkbox, and
   "View as Markdown" is a plain link. What this adds is a persisted theme
   choice, copy buttons, and a table of contents that tracks the heading you
   are reading. */

(function () {
  'use strict';

  // ---- theme -------------------------------------------------------------

  var root = document.documentElement;
  var toggle = document.querySelector('[data-theme-toggle]');

  function currentTheme() {
    if (root.dataset.theme) return root.dataset.theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.dataset.theme = next;
      try {
        localStorage.setItem('daraja-theme', next);
      } catch (e) {
        /* Private browsing. The choice just will not persist. */
      }
    });
  }

  // ---- copy buttons ------------------------------------------------------

  function flash(button, message) {
    var original = button.textContent;
    button.textContent = message;
    button.setAttribute('data-copied', '');
    setTimeout(function () {
      button.textContent = original;
      button.removeAttribute('data-copied');
    }, 1600);
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // http on a local network, which is how people preview this.
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(area);
      }
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var block = button.closest('figure').querySelector('code');
      copy(block.textContent).then(
        function () {
          flash(button, 'Copied');
        },
        function () {
          flash(button, 'Press Ctrl+C');
        },
      );
    });
  });

  var mdButton = document.querySelector('[data-copy-md]');
  if (mdButton) {
    mdButton.addEventListener('click', function () {
      fetch(mdButton.getAttribute('data-copy-md'))
        .then(function (res) {
          return res.text();
        })
        .then(function (text) {
          return copy(text);
        })
        .then(
          function () {
            flash(mdButton, 'Copied as Markdown');
          },
          function () {
            flash(mdButton, 'Could not copy');
          },
        );
    });
  }

  // ---- table of contents -------------------------------------------------

  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (link) {
      byId[link.getAttribute('href').slice(1)] = link;
    });

    var visible = [];

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var id = entry.target.id;
          var idx = visible.indexOf(id);
          if (entry.isIntersecting && idx === -1) visible.push(id);
          if (!entry.isIntersecting && idx !== -1) visible.splice(idx, 1);
        });

        tocLinks.forEach(function (link) {
          link.classList.remove('active');
        });

        if (visible.length) {
          // Mark the topmost heading currently on screen.
          var order = Object.keys(byId);
          var top = visible.slice().sort(function (a, b) {
            return order.indexOf(a) - order.indexOf(b);
          })[0];
          if (byId[top]) byId[top].classList.add('active');
        }
      },
      { rootMargin: '-56px 0px -70% 0px' },
    );

    Object.keys(byId).forEach(function (id) {
      var heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    });
  }

  // ---- close the mobile drawer after navigating --------------------------

  var navToggle = document.getElementById('nav-toggle');
  if (navToggle) {
    document.querySelectorAll('.sidebar a').forEach(function (link) {
      link.addEventListener('click', function () {
        navToggle.checked = false;
      });
    });
  }
})();
