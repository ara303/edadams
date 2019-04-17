let form = document.querySelector('.form-contact');
let XHR = new XMLHttpRequest();
let doForm = function() {
  let FD = new FormData(form);
  XHR.addEventListener('load', function(e) {
    document.querySelector('.form-success').classList.add('is-visible');
  });
  XHR.addEventListener('error', function() {
    document.querySelector('.form-failure').classList.add('is-visible');
  });
  XHR.open('POST', form.getAttribute('action'));
  XHR.send(FD);
}
form.addEventListener('submit', function(e){
  e.preventDefault();
  doForm();
});
