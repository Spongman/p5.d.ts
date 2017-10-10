@setlocal

e:
cd \play\p5.js-sound
call yarn grunt
copy /y .\lib\p5.sound* ..\p5.js\lib\addons\

REM cd \play\opentype.js
REM call yarn build
REM call yarn minify

REM copy /y E:\play\opentype.js\dist\*.js E:\play\p5.js\node_modules\opentype.js\dist\

cd \play\p5.js
call yarn grunt yui:dev --stack

cd \play\p5.d.ts
call node .\generate-typescript-annotations.js

copy /y *.d.ts ..\p5ide\
