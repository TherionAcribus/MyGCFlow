from flask_babel import Babel
from flask_compress import Compress
from flask_cors import CORS
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()
babel = Babel()
cors = CORS()
compress = Compress()
